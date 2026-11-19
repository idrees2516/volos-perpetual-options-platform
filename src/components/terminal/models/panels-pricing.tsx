'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · panels-pricing — Act III, the derivatives core (Q):
//   bsm-surface   — V(S, τ): the payoff's kink MELTING as τ grows (the heat
//                   equation run backwards — Part 10 ch3's picture)
//   greeks-atlas  — every Greek as a surface over (K, τ): Δ Γ Θ 𝒱 ρ and the
//                   second order vanna / volga / charm / speed
//   tree-pde      — the CRR lattice: N-step sawtooth converging onto the
//                   closed form; the tree → PDE limit
//   american-put   — the free boundary S*(t): the exercise region as a 3D
//                   slab, the early-exercise premium surface
//   mc-engine     — the price as an expectation: seeded path cloud +
//                   convergence band 1/√n
//   gram-charlier — the smile BORN from moments: skewness γ₁ tilts, excess
//                   kurtosis γ₂ curls — the live density morph of Part 12 ch1
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { Surface3d } from './surface3d';
import { ParamSlider, CourseNote, Readout, RerollButton } from './models-ui';
import { StatGrid, Segmented, LineChart, ChartLegend } from '@/components/terminal/quantlab/quant-viz';
import {
  bsPrice, delta, gamma, vega, theta, rho, vanna, volga, charm, speed, impliedVol,
} from '@/lib/models/bs';
import { crrTree, crrConvergence, mcEuropean, gbmFan } from '@/lib/models/processes';
import { normCdf } from '@/lib/models/normal';
import { fmtNum } from '@/lib/format';

// ── V(S, τ): the payoff melting ────────────────────────────────────────────

export function BsmSurfaceModel() {
  const [sigma, setSigma] = useState(0.4);
  const [r, setR] = useState(0.05);
  const [q, setQ] = useState(0);
  const [showPayoff, setShowPayoff] = useState(true);

  // V over (S/K ∈ [0.6, 1.4] × τ ∈ [0, 1])
  const { ss, taus, values } = useMemo(() => {
    const ss = Array.from({ length: 45 }, (_, i) => 0.6 + (i * 0.8) / 44);
    const taus = Array.from({ length: 26 }, (_, i) => (i * 1) / 25);
    const values = ss.map((s) => taus.map((tau) => bsPrice(true, 100 * s, 100, Math.max(tau, 1e-9), r, q, sigma)));
    return { ss, taus, values };
  }, [sigma, r, q]);

  // payoff ridge at τ=0 (drawn as a path on the floor edge)
  const payoffPts = ss.map((s) => ({ x: s, y: 0, z: Math.max(100 * s - 100, 0) }));

  return (
    <Dock viewId="models-bsm" layout="grid">
      <DockPanel id="surface" title="V(S, τ) · the payoff's kink, melting" sub="Black–Scholes–Merton as a surface — the heat equation run backwards" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: ss, y: taus, z: values }, mode: 'height' }]}
            paths={[{ points: payoffPts, color: showPayoff ? '#fbbf24' : 'rgba(251,191,36,0.25)', width: 2, headDot: false }]}
            xLabel="S/K"
            yLabel="time left τ (y)"
            zLabel="call value"
            height={320}
          />
          <Readout
            items={[
              { label: 'ATM, 30d', value: fmtNum(bsPrice(true, 100, 100, 30 / 365, r, q, sigma), 2), tone: 'teal' },
              { label: 'ATM, 1y', value: fmtNum(bsPrice(true, 100, 100, 1, r, q, sigma), 2) },
              { label: 'N(d1)-delta, ATM 30d', value: fmtNum(delta(true, 100, 100, 30 / 365, r, q, sigma), 3) },
              { label: 'γ²τ only', value: 'the equation knows σ²τ — double σ, quarter the melting time' },
            ]}
          />
          <CourseNote
            parts="Part 10 ch3–6 · Part 9 ch6"
            idea="Black and Scholes solved their PDE through the heat equation: at τ=0 the hockey-stick ridge; as τ grows the Gaussian kernel convolves it — the area under kernel × payoff IS the option's height. Double σ and the melting time quarters."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Model inputs" span={1}>
        <div className="space-y-3">
          <ParamSlider label="volatility σ" value={sigma} min={0.05} max={1.2} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="rate r" value={r} min={0} max={0.15} step={0.005} onChange={setR} format={(v) => `${(v * 100).toFixed(1)}%`} />
          <ParamSlider label="carry q" value={q} min={0} max={0.1} step={0.005} onChange={setQ} format={(v) => `${(v * 100).toFixed(1)}%`} />
          <button
            onClick={() => setShowPayoff((v) => !v)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[9px] uppercase tracking-wider text-zinc-400 transition hover:border-teal-700/60 hover:text-teal-300"
          >
            {showPayoff ? 'hide' : 'show'} payoff ridge
          </button>
          <StatGrid
            cols={2}
            stats={[
              { label: 'μ independence', value: 'yes', sub: 'the PDE kills μ — two investors who disagree on direction agree on price' },
              { label: 'implied from ATM 30d', value: fmtNum((impliedVol(bsPrice(true, 100, 100, 30 / 365, r, q, sigma), true, 100, 100, 30 / 365, r, q) ?? 0) * 100, 1) + '%', sub: 'one quote inverted — the market\'s fear out' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the Greeks atlas ────────────────────────────────────────────────────────

type GreekId = 'delta' | 'gamma' | 'theta' | 'vega' | 'rho' | 'vanna' | 'volga' | 'charm' | 'speed';

const GREEK_LABEL: Record<GreekId, string> = {
  delta: 'Δ = ∂V/∂S',
  gamma: 'Γ = ∂²V/∂S²',
  theta: 'Θ/365 (per day)',
  vega: '𝒱 per vol point',
  rho: 'ρ per rate point',
  vanna: 'vanna ∂Δ/∂σ',
  volga: 'volga ∂𝒱/∂σ',
  charm: 'charm ∂Δ/∂t',
  speed: 'speed ∂Γ/∂S',
};

const GREEK_NOTE: Record<GreekId, string> = {
  delta: 'the hedge ratio — N(d1) under Q; note the pinching at short τ near the strike',
  gamma: 'the curvature ridge — sharpens at the strike as expiry approaches (0DTE gamma)',
  theta: 'the bleed — deepest at the money at short τ; Θ = −½σ²S²Γ at r=q=0 (the PDE!)',
  vega: 'the vol exposure — maximal ATM, dies at expiry; 𝒱 = στS²Γ (one bump, two Greeks)',
  rho: 'rate sensitivity — grows with strike and maturity (the discount factor)',
  vanna: 'how the hedge ratio shifts when vol moves — the wings carry it, ATM ≈ 0',
  volga: 'the convexity of vega — ATM ≈ 0 (d1d2 < 0), the wings convex (25Δ strangles)',
  charm: 'the delta your hedge loses overnight — expiry acceleration near the strike',
  speed: 'where the gamma ridge steepens — gamma of gamma; expiry’s sharpening rate',
};

export function GreeksAtlasModel() {
  const [greek, setGreek] = useState<GreekId>('gamma');
  const [sigma, setSigma] = useState(0.45);
  const [r, setR] = useState(0.05);

  const { ks, taus, values, atm30, atm7, atm1 } = useMemo(() => {
    const ks = Array.from({ length: 41 }, (_, i) => 0.75 + (i * 0.5) / 40);
    const taus = Array.from({ length: 26 }, (_, i) => 1 / 365 + (i * 2) / 25);
    const f = (call: boolean, S: number, K: number, T: number, rr: number, qq: number, sg: number): number => {
      switch (greek) {
        case 'delta': return delta(call, S, K, T, rr, qq, sg);
        case 'theta': return theta(call, S, K, T, rr, qq, sg) / 365;
        case 'vega': return vega(S, K, T, rr, qq, sg) * 0.01;
        case 'rho': return rho(call, S, K, T, rr, qq, sg);
        case 'vanna': return vanna(S, K, T, rr, qq, sg);
        case 'volga': return volga(S, K, T, rr, qq, sg);
        case 'charm': return charm(call, S, K, T, rr, qq, sg);
        case 'speed': return speed(S, K, T, rr, qq, sg);
        default: return gamma(S, K, T, rr, qq, sg);
      }
    };
    const values = ks.map((k) => taus.map((tau) => f(true, 100, 100 * k, tau, r, 0, sigma)));
    return { ks, taus, values, atm30: f(true, 100, 100, 30 / 365, r, 0, sigma), atm7: f(true, 100, 100, 7 / 365, r, 0, sigma), atm1: f(true, 100, 100, 1 / 365, r, 0, sigma) };
  }, [greek, sigma, r]);

  return (
    <Dock viewId="models-greeks" layout="grid">
      <DockPanel id="atlas" title={`Greeks atlas · ${GREEK_LABEL[greek]}`} sub="over (strike K × time to expiry τ) — the risk report as terrain" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: ks.map((k) => k * 100), y: taus.map((t) => t * 365), z: values }, mode: 'height' }]}
            planes={[{ axis: 'y', at: 0, color: 'rgba(45,212,191,1)', alpha: 0.04 }]}
            xLabel="strike"
            yLabel="days to expiry"
            zLabel={greek}
            height={320}
          />
          <Readout
            items={[
              { label: 'ATM 30d', value: fmtNum(atm30, 4) },
              { label: 'ATM 7d', value: fmtNum(atm7, 4) },
              { label: 'ATM 1d', value: fmtNum(atm1, 4) },
              { label: 'note', value: GREEK_NOTE[greek] },
            ]}
          />
          <CourseNote
            parts="Part 10 ch6 · Part 11 ch1, 4"
            idea="Greeks are geometry: Δ is the tangent plane's slope, Γ the bowl's depth (½ΓdS²), Θ the overnight drop (the two cancel at the breakeven move σ√dt), vanna/volga the smile's second-order fingerprint — one Taylor series in three variables."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Choose your Greek" span={1}>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1">
            {(['delta', 'gamma', 'theta', 'vega', 'rho', 'vanna', 'volga', 'charm', 'speed'] as GreekId[]).map((g) => (
              <button
                key={g}
                onClick={() => setGreek(g)}
                className={`rounded-md px-1.5 py-1 text-[9.5px] font-medium transition ${greek === g ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'bg-zinc-950/60 text-zinc-500 hover:text-zinc-300'}`}
              >
                {g}
              </button>
            ))}
          </div>
          <ParamSlider label="volatility σ" value={sigma} min={0.1} max={1.2} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="rate r" value={r} min={0} max={0.15} step={0.005} onChange={setR} format={(v) => `${(v * 100).toFixed(1)}%`} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'Θ = −½σ²S²Γ', value: 'the PDE', sub: 'theta is the rent of gamma — the two trade off exactly at r=q=0' },
              { label: '𝒱 = στS²Γ', value: 'identity', sub: 'long gamma and long vega go together for vanillas' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the tree converging to the PDE ─────────────────────────────────────────

export function TreePdeModel() {
  const [sigma, setSigma] = useState(0.2);
  const [r, setR] = useState(0.05);
  const [K, setK] = useState(100);

  const conv = useMemo(() => crrConvergence(100, K, 1, r, 0, sigma, Array.from({ length: 40 }, (_, i) => 2 + i * 10)), [K, r, sigma]);
  const exact = bsPrice(true, 100, K, 1, r, 0, sigma);
  const t400 = crrTree(100, K, 1, r, 0, sigma, 400);

  // 3D: the N=40 tree's node values over (j, i) — a slab of the lattice
  const { js, levels } = useMemo(() => {
    const N = 40;
    const tree = crrTree(100, K, 1, r, 0, sigma, N);
    void tree;
    // recompute node values ourselves for the visual (European values)
    const js = Array.from({ length: 2 * N + 1 }, (_, j) => j);
    const levels: number[][] = [];
    for (let i = 0; i <= N; i += 8) {
      const row: number[] = [];
      for (let j = 0; j < 2 * N + 1; j++) {
        // node (i, j): S = 100·u^(j−i)·... map j → (up − down) index around S0
        const upDown = j - N; // j−N = number of up steps minus down steps
        const S = 100 * Math.exp((2 * upDown) * (sigma / Math.sqrt(N)));
        row.push(bsPrice(true, S, K, 1 - i / N, r, 0, sigma));
      }
      levels.push(row);
    }
    return { js, levels };
  }, [K, r, sigma]);
  const levelTs = Array.from({ length: levels.length }, (_, i) => i * 8);
  // SurfaceData wants z[xi][yi] (x-major) — `levels` is [time-slice][j], so transpose
  const zGrid = js.map((_, xi) => levels.map((row) => row[xi]));

  return (
    <Dock viewId="models-tree" layout="grid">
      <DockPanel id="sawtooth" title="The tree converging to the PDE · CRR sawtooth" sub="N = 2…400 vs the closed form — the lattice IS the discretised PDE" span={1}>
        <div className="space-y-2">
          <LineChart
            series={[
              { label: 'CRR European call', color: '#2dd4bf', points: conv.map((c) => ({ x: c.N, y: c.euroCall })) },
              { label: 'Black–Scholes closed form', color: '#a78bfa', points: conv.map((c) => ({ x: c.N, y: exact })), dashed: true },
            ]}
            height={170}
            yFormat={(v) => fmtNum(v, 1)}
            xFormat={(v) => `N=${v.toFixed(0)}`}
          />
          <ChartLegend series={[{ label: 'CRR', color: '#2dd4bf' }, { label: 'BSM', color: '#a78bfa' }]} />
          <Readout
            items={[
              { label: 'N=400', value: fmtNum(t400.euroCall, 4) },
              { label: 'closed form', value: fmtNum(exact, 4), tone: 'teal' },
              { label: 'gap', value: fmtNum(Math.abs(t400.euroCall - exact), 4) },
              { label: 'the course pair', value: '10.4456 → 10.4506' },
            ]}
          />
        </div>
      </DockPanel>
      <DockPanel id="lattice3d" title="The lattice as a surface · node values by (j, i)" sub="one step 120/90 → four steps → 400: the sawtooth is the odd–even parity of the kink" span={1}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: js, y: levelTs, z: zGrid }, mode: 'height' }]}
            xLabel="node j (up-down)"
            yLabel="time slice i"
            zLabel="call value"
            height={230}
          />
          <CourseNote
            parts="Part 9 ch6 · Part 10 ch5 · Part 16"
            idea="Cox–Ross–Rubinstein: u = e^{σ√dt}, d = 1/u, p = (e^{r dt} − d)/(u − d). The one-step tree is arbitrage geometry; the N→∞ limit is the PDE — this surface flattening as dt → 0."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Tree parameters" span={2}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-3">
            <ParamSlider label="strike K" value={K} min={70} max={130} step={1} onChange={setK} format={(v) => fmtNum(v, 0)} />
            <ParamSlider label="volatility σ" value={sigma} min={0.1} max={0.8} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
            <ParamSlider label="rate r" value={r} min={0} max={0.15} step={0.005} onChange={setR} format={(v) => `${(v * 100).toFixed(1)}%`} />
          </div>
          <StatGrid
            cols={2}
            stats={[
              { label: 'one step 120/90', value: `${fmtNum(bsPrice(true, 100, K, 1 / 1, r, 0, sigma), 2)} → Part 9's geometry`, sub: 'the first node: price = e^{−rdt}(p·V_u + (1−p)·V_d)' },
              { label: 'u, d', value: `u = e^{σ√dt} ↔ 1/u`, sub: 'volatility sets the spread of the branches — nothing else' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the American put's free boundary ────────────────────────────────────────

export function AmericanPutModel() {
  const [sigma, setSigma] = useState(0.3);
  const [r, setR] = useState(0.05);
  const [K, setK] = useState(110);

  // exercise map over (S × t) from a fine CRR tree
  const { ss, ts, exercise, boundary, premium } = useMemo(() => {
    const N = 120;
    const T = 1;
    const ss = Array.from({ length: 41 }, (_, i) => 70 + (i * 60) / 40);
    const ts = Array.from({ length: 21 }, (_, i) => (i * T) / 20);
    // exercise surface: 1 where immediate exercise ≥ continuation (from tree boundary)
    const tree = crrTree(100, K, T, r, 0, sigma, N);
    const exercise: number[][] = ss.map((S) => ts.map((t) => (S <= (tree.putBoundary[Math.round((1 - t) * N)] ?? 0) + 1e-9 ? 1 : 0)));
    // premium surface P_A − P_E
    const premium = ss.map((S) => ts.map((t) => {
      const t0 = crrTree(S, K, Math.max(t, 1 / 365), r, 0, sigma, 120);
      return t0.amerPut - t0.euroPut;
    }));
    const boundary = tree.putBoundary.map((b, i) => ({ x: b ?? K, y: (i / N) * T, z: (b ?? K) })).filter((pt) => pt.x != null && Number.isFinite(pt.x));
    return { ss, ts, exercise, boundary, premium };
  }, [sigma, r, K]);

  const t2 = crrTree(100, K, 1, r, 0, sigma, 2000);
  const pe = t2.euroPut;
  const pa = t2.amerPut;

  return (
    <Dock viewId="models-american" layout="grid">
      <DockPanel id="region" title="The early-exercise region · S*(t) free boundary" sub="where the American put's holder says 'exercise NOW' — the slab glows" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: ss, y: ts, z: exercise }, mode: 'height' }]}
            paths={[{ points: boundary, color: '#fb7185', width: 2, headDot: true }]}
            xLabel="spot S"
            yLabel="t (years)"
            zLabel="exercise"
            zDomain={[0, 1]}
            height={300}
            formatZ={(v) => (v > 0.5 ? 'EXERCISE' : 'hold')}
          />
          <Readout
            items={[
              { label: 'European put', value: fmtNum(pe, 4) },
              { label: 'American put', value: fmtNum(pa, 4), tone: 'teal' },
              { label: 'early-exercise premium', value: fmtNum(pa - pe, 4), tone: 'amber' },
              { label: 'S*(0) boundary at t=0', value: fmtNum(boundary[0]?.x ?? NaN, 2), tone: 'rose' },
            ]}
          />
          <CourseNote
            parts="Part 10 ch11, 14 · Part 8 ch12"
            idea="Merton 1973: an American CALL on a non-dividend stock never exercises early — the put does, below S*(t): K − S beats waiting. Kim/Carr–Jarrow–Myneni write the premium as an integral over the boundary; Barone-Adesi–Whaley approximate it. Smooth fit: the value surface's slope matches the payoff's at S*."
          />
        </div>
      </DockPanel>
      <DockPanel id="premium3d" title="Early-exercise premium P_A − P_E · the surface the tree pays for patience" span={1}>
        <Surface3d
          surfaces={[{ data: { x: ss, y: ts, z: premium }, mode: 'height' }]}
          xLabel="spot S"
          yLabel="t (years)"
          zLabel="premium"
          height={240}
        />
      </DockPanel>
      <DockPanel id="controls" title="Put parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="strike K" value={K} min={90} max={130} step={1} onChange={setK} format={(v) => fmtNum(v, 0)} />
          <ParamSlider label="volatility σ" value={sigma} min={0.1} max={0.8} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="rate r" value={r} min={0} max={0.15} step={0.005} onChange={setR} format={(v) => `${(v * 100).toFixed(1)}%`} hint="higher r ⇒ exercise sooner (the money earns r)" />
          <StatGrid
            cols={2}
            stats={[
              { label: 'r = 0 case', value: 'A = E', sub: 'with no interest there is no urgency — premium collapses to zero' },
              { label: 'why exercise?', value: 'K−S now earns r', sub: 'the time value of money versus the optionality you give up' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the Monte Carlo engine ─────────────────────────────────────────────────

export function McEngineModel() {
  const [sigma, setSigma] = useState(0.4);
  const [seed, setSeed] = useState(42);
  const [nPaths, setNPaths] = useState(120);
  const [call, setCall] = useState(true);

  const { paths, mc, exact } = useMemo(() => {
    const T = 0.5;
    const steps = 60;
    const fan = gbmFan(seed, nPaths, 100, T, steps, 0.05, sigma);
    // path cloud: (t, path index, S) — Array.from: TypedArray.map can't make objects
    const paths = fan.map((p) => Array.from(p, (S, i) => ({ x: (i / steps) * T, y: 0, z: S })));
    const mc = mcEuropean(call, 100, 100, T, 0.05, 0, sigma, 24000, seed);
    const exact = bsPrice(call, 100, 100, T, 0.05, 0, sigma);
    return { paths, mc, exact };
  }, [sigma, seed, nPaths, call]);

  // convergence band: price estimate vs n
  const convSeries = useMemo(() => {
    const T = 0.5;
    const z: { x: number; y: number }[] = [];
    for (const n of [100, 250, 1000, 2500, 10000, 40000, 120000]) {
      const m = mcEuropean(call, 100, 100, T, 0.05, 0, sigma, n, seed);
      z.push({ x: n, y: m.price });
    }
    return [{ label: 'MC estimate', color: '#2dd4bf', points: z }];
  }, [sigma, seed, call]);

  const zMin = Math.min(...paths.map((p) => Math.min(...p.map((pt) => pt.z))));
  const zMax = Math.max(...paths.map((p) => Math.max(...p.map((pt) => pt.z))));

  return (
    <Dock viewId="models-mc" layout="grid">
      <DockPanel id="cloud" title="The price as an expectation · path cloud under Q" sub={`e^{−rT}·mean(payoff) — ${nPaths} seeded paths`} span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: [0, 0.5], y: [0, 1], z: [[0, 0], [0, 0]] } }]}
            paths={paths.slice(0, 26).map((pts, i) => ({
              points: pts.map((pt, j) => ({ x: pt.x, y: (j % 7) / 7, z: pt.z })),
              color: i === 0 ? 'rgba(45,212,191,0.95)' : `rgba(113,113,122,${0.25 + 0.4 * (i / 26)})`,
              width: i === 0 ? 2 : 1,
            }))}
            planes={[{ axis: 'y', at: 0.5, color: 'rgba(251,191,36,1)', alpha: 0.05 }]}
            xLabel="t (years)"
            yLabel="path # (fan)"
            zLabel="S"
            zDomain={[zMin, zMax]}
            height={300}
          />
          <Readout
            items={[
              { label: 'MC price', value: `${fmtNum(mc.price, 3)} ± ${fmtNum(mc.stderr, 3)}`, tone: 'teal' },
              { label: 'closed form', value: fmtNum(exact, 3) },
              { label: 'gap / stderr', value: fmtNum(Math.abs(mc.price - exact) / (mc.stderr || 1), 2) + 'σ' },
              { label: 'paths', value: mc.nPaths.toLocaleString() },
            ]}
          />
          <CourseNote
            parts="Part 10 ch4 · Part 15"
            idea="Feynman–Kac read for BSM: the price IS an average under Q. The seed_band narrows like 1/√n onto the formula line — the Girsanov-weighted P-paths estimator is wider (weights spread). Antithetic pairs halve the variance."
          />
        </div>
      </DockPanel>
      <DockPanel id="conv" title="Convergence · the 1/√n band" span={1}>
        <LineChart
          series={[...convSeries, { label: 'exact', color: '#a78bfa', points: convSeries[0].points.map((p) => ({ x: p.x, y: exact })), dashed: true }]}
          height={150}
          yFormat={(v) => fmtNum(v, 2)}
          xFormat={(v) => `n=${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
        />
        <ChartLegend series={[{ label: 'MC', color: '#2dd4bf' }, { label: 'BSM', color: '#a78bfa' }]} />
      </DockPanel>
      <DockPanel id="controls" title="Engine parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="volatility σ" value={sigma} min={0.1} max={1.2} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="paths shown" value={nPaths} min={12} max={240} step={12} onChange={setNPaths} />
          <Segmented value={call ? 'call' : 'put'} onChange={(v) => setCall(v === 'call')} options={[{ id: 'call', label: 'call' }, { id: 'put', label: 'put' }]} />
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the smile born from moments (Gram–Charlier) ────────────────────────────

export function GramCharlierModel() {
  const [sigma, setSigma] = useState(0.35);
  const [g1, setG1] = useState(-0.8);
  const [g2, setG2] = useState(0.4);

  // Backus–Foresi–Wu first-order: σ_imp(d) ≈ σ[1 − (γ1/6)d + (γ2/24)(d² − 1)],
  // d = −k/(σ√τ) — skewness tilts, kurtosis curls
  const { ks, taus, ivs, density } = useMemo(() => {
    const ks = Array.from({ length: 41 }, (_, i) => -0.35 + (i * 0.7) / 40);
    const taus = Array.from({ length: 16 }, (_, i) => 1 / 24 + (i * 1.5) / 15);
    const ivs = ks.map((k) => taus.map((tau) => {
      const d = -k / (sigma * Math.sqrt(tau));
      return sigma * (1 - (g1 / 6) * d + (g2 / 24) * (d * d - 1));
    }));
    // the Gram–Charlier density itself at T=1 (for the side chart)
    const density = ks.map((k) => {
      const d = -k / sigma;
      const He3 = d ** 3 - 3 * d;
      const He4 = d ** 4 - 6 * d * d + 3;
      return (Math.exp(-0.5 * d * d) / (sigma * Math.sqrt(2 * Math.PI))) * (1 + (g1 / 6) * He3 + (g2 / 24) * He4);
    });
    return { ks, taus, ivs, density };
  }, [sigma, g1, g2]);

  return (
    <Dock viewId="models-gramcharlier" layout="grid">
      <DockPanel id="smile3d" title="The smile born from moments" sub="risk-neutral skewness γ₁ tilts it · excess kurtosis γ₂ curls it — the surface a density implies" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: ks, y: taus, z: ivs }, mode: 'height' }]}
            xLabel="log-moneyness k"
            yLabel="expiry τ (y)"
            zLabel="implied vol"
            height={300}
            formatZ={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Readout
            items={[
              { label: 'ATM σ(0,τ) ', value: `${(sigma * 100).toFixed(0)}%` },
              { label: 'put wing σ(−0.3, 1y)', value: `${((sigma * (1 - (g1 / 6) * (0.3 / sigma) + (g2 / 24) * ((0.3 / sigma) ** 2 - 1))) * 100).toFixed(1)}%`, tone: g1 < 0 ? 'rose' : 'teal' },
              { label: 'call wing σ(+0.3, 1y)', value: `${((sigma * (1 - (g1 / 6) * (-0.3 / sigma) + (g2 / 24) * ((0.3 / sigma) ** 2 - 1))) * 100).toFixed(1)}%`, tone: g1 < 0 ? 'teal' : 'rose' },
            ]}
          />
          <CourseNote
            parts="Part 12 ch1 · Backus–Foresi–Wu 2004"
            idea="Read the smile backwards: γ₁ < 0 (fat LEFT tail) ⇒ puts dearer ⇒ the post-1987 skew; γ₂ > 0 (fat both tails) ⇒ both wings lift ⇒ the smile. The density and the surface are the same object in two coordinates."
          />
        </div>
      </DockPanel>
      <DockPanel id="density" title="The density you are implying" sub="Gram–Charlier: q(x) = φ(x)[1 + γ₁/6·He₃ + γ₂/24·He₄]" span={1}>
        <LineChart
          series={[{ label: 'implied density', color: '#2dd4bf', points: ks.map((k, i) => ({ x: k, y: density[i] })) }]}
          height={150}
          yFormat={(v) => fmtNum(v, 1)}
          xFormat={(v) => fmtNum(v, 2)}
        />
        <div className="space-y-3">
          <ParamSlider label="skewness γ₁" value={g1} min={-1.5} max={1.5} step={0.1} onChange={setG1} hint="negative = crash fear = put skew" />
          <ParamSlider label="excess kurtosis γ₂" value={g2} min={-1} max={2} step={0.1} onChange={setG2} hint="fat tails = both wings lift" />
          <ParamSlider label="base vol σ" value={sigma} min={0.1} max={0.8} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
        </div>
      </DockPanel>
    </Dock>
  );
}
