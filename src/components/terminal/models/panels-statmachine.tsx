'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · panels-statmachine — Act V: The Statistical Machine.
//
// The new model wing, every engine from src/lib/models/{stochastic,
// timeseries,regimes,ml,portfolio,mcfan} rendered as an interactive model:
//   • heston-engine   — the Heston smile repriced live + SABR calibrated to
//                        match it (two smile languages, one picture)
//   • jump-diffusion  — Merton gap-risk: mixture density vs the Gaussian it
//                        replaced, tail mass, and what it does to OTM puts
//   • regime-hmm      — the 3-state Hidden Markov machine on seeded
//                        regime-switching data — decode vs ground truth
//   • garch-vol       — vol clustering: the fit, the forecast fan, persistence
//   • kalman-ou       — the honest trend filter + the rubber band
//   • ml-lab          — the P(up) classifier: boundary, accuracy, forest
//   • portfolio-kelly — the growth-optimal fraction and its cliff
//   • live-room       — THE LIVE ROOM: every model fitted on real bars, with
//                        the exact product surfaces already consuming it
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { PanelState } from '@/components/ui/panel-state';
import { StatGrid, Segmented } from '@/components/terminal/quantlab/quant-viz';
import { ParamSlider, CourseNote, Readout, RerollButton } from './models-ui';
import {
  hestonSmile, calibrateSabr, sabrImpliedVol, mertonJumpPrice, jumpTailMass, mertonM,
} from '@/lib/models/stochastic';
import { strikeForDelta } from '@/lib/models/volsurface';
import { mulberry32 } from '@/lib/models/rng';
import { fitGarch, garchForecast, fitOu, ouStretch, kalmanTrend, kalmanVerdict } from '@/lib/models/timeseries';
import { fitHmm, hmmRegime, simulateRegimeReturns } from '@/lib/models/regimes';
import { trainLogistic, logisticEvaluate, miniForest, forestPredict, solveRidge } from '@/lib/models/ml';
import { kellyFraction, kellyGrowth, tailRisk, riskParity, drawdown } from '@/lib/models/portfolio';
import { fmtNum, fmtPctSigned } from '@/lib/format';
import { Loader2, RefreshCw } from 'lucide-react';
// --- shared atoms ---------------------------------------------------------------

interface Series {
  name: string;
  points: { x: number; y: number }[];
  color: string;
  dashed?: boolean;
  dot?: boolean;
}

function LineChart({ series, height = 150, xLabel, yLabel, yPad = 0.08 }: { series: Series[]; height?: number; xLabel?: string; yLabel?: string; yPad?: number }) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return <div className="h-[150px]" />;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  const span = yHi - yLo || 1;
  const lo = yLo - span * yPad;
  const hi = yHi + span * yPad;
  const W = 320;
  const H = height;
  const sx = (x: number) => ((x - x0) / (x1 - x0 || 1)) * (W - 24) + 12;
  const sy = (y: number) => H - 14 - ((y - lo) / (hi - lo || 1)) * (H - 26);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}>
        {series.map((s, i) =>
          s.dot ? (
            <g key={i}>
              {s.points.map((p, j) => (
                <circle key={j} cx={sx(p.x)} cy={sy(p.y)} r={1.7} fill={s.color} opacity={0.85} />
              ))}
            </g>
          ) : (
            <polyline
              key={i}
              fill="none"
              stroke={s.color}
              strokeWidth={1.6}
              strokeDasharray={s.dashed ? '4 3' : undefined}
              points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
            />
          ),
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[8px] text-zinc-500">
        {series.map((s, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {xLabel && <span className="ml-auto">{xLabel}</span>}
        {yLabel && <span>{yLabel}</span>}
      </div>
    </div>
  );
}

/** ── 1 · Heston engine + SABR calibration ──────────────────────────────────── */

export function HestonEngineModel() {
  const [v0Pct, setV0Pct] = useState(40);
  const [kappa, setKappa] = useState(1.5);
  const [thetaPct, setThetaPct] = useState(45);
  const [xi, setXi] = useState(0.9);
  const [rho, setRho] = useState(-0.5);
  const [T, setT] = useState(0.25);

  const { grid, heston, sabr, readouts } = useMemo(() => {
    const S = 100;
    const r = 0.03;
    const q = 0;
    const p = { v0: (v0Pct / 100) ** 2, kappa, theta: (thetaPct / 100) ** 2, xi, rho };
    const moneyness = Array.from({ length: 17 }, (_, i) => 0.84 + i * 0.02);
    const smile = hestonSmile(S, T, r, q, p, moneyness);
    const atmIv = smile.find((s) => Math.abs(s.k - 1) < 1e-9)?.iv ?? smile[8]?.iv ?? 0.45;
    // 25Δ strikes from the ATM vol
    const k25c = strikeForDelta(0.25, S, T, r, q, atmIv);
    const k25p = strikeForDelta(-0.25, S, T, r, q, atmIv);
    const ivOf = (k: number): number => {
      // linear interpolation on the smile
      const ks = smile.map((s) => s.k);
      let i = 0;
      while (i < ks.length - 1 && ks[i] < k / S) i++;
      const a = smile[Math.max(0, i - 1)];
      const b = smile[Math.min(smile.length - 1, i)];
      const w = b.k === a.k ? 0 : (k / S - a.k) / (b.k - a.k);
      return a.iv + w * (b.iv - a.iv);
    };
    const rr = ivOf(k25c) - ivOf(k25p);
    const fly = (ivOf(k25c) + ivOf(k25p)) / 2 - atmIv;
    const cal = calibrateSabr(S, T, atmIv, rr, fly);
    return {
      grid: moneyness,
      heston: smile,
      sabr: cal,
      readouts: {
        atmIv,
        rr,
        fly,
        put25: smile.find((s) => s.k < 0.92)?.price ?? 0,
        sabrParams: cal.params,
        resid: cal.resid,
      },
    };
  }, [v0Pct, kappa, thetaPct, xi, rho, T]);

  return (
    <Dock viewId="models-heston">
      <DockPanel id="heston-smile" title="The Heston smile — vol as a mean-reverting process" span={2}>
        <div className="space-y-2 p-3">
          <div className="grid gap-2 lg:grid-cols-2">
            <div className="grid grid-cols-2 gap-x-4">
              <ParamSlider label="spot vol σ₀" value={v0Pct} min={5} max={120} step={1} onChange={setV0Pct} format={(v) => `${v.toFixed(0)}%`} />
              <ParamSlider label="long-run σ̄" value={thetaPct} min={5} max={120} step={1} onChange={setThetaPct} format={(v) => `${v.toFixed(0)}%`} />
              <ParamSlider label="mean-reversion κ" value={kappa} min={0.2} max={8} step={0.1} onChange={setKappa} format={(v) => v.toFixed(1)} />
              <ParamSlider label="vol-of-vol ξ" value={xi} min={0.05} max={2.5} step={0.05} onChange={setXi} format={(v) => v.toFixed(2)} />
              <ParamSlider label="correlation ρ" value={rho} min={-0.95} max={0.95} step={0.05} onChange={setRho} format={(v) => v.toFixed(2)} />
              <ParamSlider label="maturity T" value={T} min={0.02} max={1.5} step={0.01} onChange={setT} format={(v) => `${v.toFixed(2)}y`} />
            </div>
            <div>
              <LineChart
                height={170}
                series={[
                  { name: 'Heston IV', points: heston.map((s) => ({ x: s.k, y: s.iv })), color: '#2dd4bf' },
                  { name: 'SABR (fitted to Heston)', points: grid.map((k) => ({ x: k, y: sabrImpliedVol(100, 100 * k, T, sabr.params) })), color: '#a78bfa', dashed: true },
                  { name: 'flat BS', points: grid.map((k) => ({ x: k, y: readouts.atmIv })), color: '#71717a', dashed: true },
                ]}
                xLabel="moneyness K/S"
                yLabel="implied vol"
              />
            </div>
          </div>
          <Readout
            items={[
              { label: 'ATM IV', value: `${(readouts.atmIv * 100).toFixed(1)}%`, tone: 'teal' },
              { label: '25Δ RR', value: `${(readouts.rr * 100).toFixed(1)} pts`, tone: readouts.rr < 0 ? 'rose' : 'amber' },
              { label: '25Δ fly', value: `${(readouts.fly * 100).toFixed(1)} pts` },
              { label: 'SABR α/ρ/ν', value: `${sabr.params.alpha.toFixed(2)} / ${sabr.params.rho.toFixed(2)} / ${sabr.params.nu.toFixed(2)}`, tone: 'zinc' },
              { label: 'SABR fit resid', value: `rr ${(sabr.resid.rr * 100).toFixed(2)} · fly ${(sabr.resid.fly * 100).toFixed(2)} pts` },
            ]}
          />
          <CourseNote parts="the statistical machine" idea="Heston prices the smile from a VARANCE process; SABR fits a closed form to it — two languages, one curve. Drag ρ to bend the skew, ξ to curl the wings, κ to see how fast vol forgets." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 2 · Merton jump diffusion ─────────────────────────────────────────────── */

export function JumpDiffusionModel() {
  const [lam, setLam] = useState(8);
  const [muJ, setMuJ] = useState(-0.1);
  const [sigJ, setSigJ] = useState(0.06);
  const [sigma, setSigma] = useState(0.4);

  const { xs, mixDens, gaussDens, tails, putM, putBs } = useMemo(() => {
    const p = { lambda: lam, muJ, sigmaJ: sigJ };
    const T = 0.25;
    const xs = Array.from({ length: 61 }, (_, i) => -0.9 + i * 0.03);
    // mixture density of the T-horizon log-return
    const dens = (x: number): number => {
      const m = mertonM(p);
      let acc = 0;
      let w = Math.exp(-p.lambda * T);
      for (let n = 0; n <= 40; n++) {
        const s = Math.sqrt(Math.max(1e-9, sigma * sigma * T + n * sigJ * sigJ));
        const mu = (0.03 - sigma * sigma / 2 - p.lambda * m) * T + n * muJ;
        acc += (w * Math.exp(-0.5 * ((x - mu) / s) ** 2)) / (s * Math.sqrt(2 * Math.PI));
        w *= (p.lambda * T) / (n + 1);
      }
      return acc;
    };
    const g = (x: number): number => {
      const s = sigma * Math.sqrt(T);
      const mu = (0.03 - sigma * sigma / 2) * T;
      return Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
    };
    return {
      xs,
      mixDens: xs.map((x) => ({ x, y: dens(x) })),
      gaussDens: xs.map((x) => ({ x, y: g(x) })),
      tails: jumpTailMass(p, sigma, T, 3),
      putM: mertonJumpPrice(false, 100, 75, T, 0.03, 0, sigma, p).price,
      putBs: mertonJumpPrice(false, 100, 75, T, 0.03, 0, sigma, { lambda: 1e-9, muJ: 0, sigmaJ: 1e-9 }).price,
    };
  }, [lam, muJ, sigJ, sigma]);

  return (
    <Dock viewId="models-jump">
      <DockPanel id="jump-tails" title="Merton gaps — the tails the Gaussian forgot" span={2}>
        <div className="space-y-2 p-3">
          <div className="grid gap-2 lg:grid-cols-2">
            <div className="grid grid-cols-2 gap-x-4">
              <ParamSlider label="jump intensity λ /yr" value={lam} min={0} max={30} step={0.5} onChange={setLam} format={(v) => v.toFixed(1)} />
              <ParamSlider label="mean jump μ_J" value={muJ} min={-0.3} max={0.3} step={0.01} onChange={setMuJ} format={(v) => v.toFixed(2)} />
              <ParamSlider label="jump size σ_J" value={sigJ} min={0.005} max={0.3} step={0.005} onChange={setSigJ} format={(v) => v.toFixed(3)} />
              <ParamSlider label="diffusion σ" value={sigma} min={0.1} max={1.2} step={0.01} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
            </div>
            <LineChart
              height={170}
              series={[
                { name: 'Merton mixture density', points: mixDens, color: '#2dd4bf' },
                { name: 'Gaussian (same σ)', points: gaussDens, color: '#f43f5e', dashed: true },
              ]}
              xLabel="3-month log-return"
              yLabel="density"
            />
          </div>
          <Readout
            items={[
              { label: '3σ tail mass', value: `${(tails.merton * 100).toFixed(2)}%`, tone: 'rose' as const },
              { label: '× Gaussian', value: `${(tails.merton / Math.max(1e-9, tails.gaussian)).toFixed(1)}×`, tone: 'amber' as const },
              { label: 'OTM 75-strike put (Merton)', value: fmtNum(putM, 2), tone: 'teal' as const },
              { label: 'same put (Black–Scholes)', value: fmtNum(putBs, 2), tone: 'zinc' as const },
              { label: 'put premium ratio', value: `${(putM / Math.max(1e-9, putBs)).toFixed(2)}×`, tone: 'amber' as const },
            ]}
          />
          <CourseNote parts="the statistical machine" idea="Poisson jumps put mass where the Gaussian has none — the 3σ event stops being a 0.3% miracle and becomes a priced risk. Watch the OTM put light up while the ATM world barely notices." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 3 · HMM regime explorer ───────────────────────────────────────────────── */

export function RegimeHmmModel() {
  const [seed, setSeed] = useState(99);
  const [k, setK] = useState<'2' | '3'>('3');

  const { truth, fit, reg, matchPct } = useMemo(() => {
    const sim = simulateRegimeReturns(seed, 600, { pStay: 0.96 });
    const f = fitHmm(sim.returns, { k: Number(k) });
    if (!f) return { truth: sim, fit: null, reg: null, matchPct: 0 };
    const r = hmmRegime(f);
    // state recovery vs ground truth (map by σ ordering)
    const match = sim.states.filter((s, i) => f.path[i] === s).length / sim.states.length;
    return { truth: sim, fit: f, reg: r, matchPct: match };
  }, [seed, k]);

  const rets = truth.returns;
  const xs = rets.map((_, i) => i);
  return (
    <Dock viewId="models-hmm">
      <DockPanel id="hmm-decode" title="The regime machine — hidden states decoded from returns" span={2}>
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <RerollButton seed={seed} onSeed={() => setSeed((s) => s + 1)} />
            <div className="w-40">
              <Segmented value={k} onChange={(v) => setK(v)} options={[{ id: '2', label: '2 states' }, { id: '3', label: '3 states' }]} />
            </div>
            {fit && reg && (
              <span className="font-mono text-[10px] text-teal-300">
                decoded {reg.label.toUpperCase()} @ {(reg.prob * 100).toFixed(0)}% · E[run] {Number.isFinite(reg.expectedDurationBars) ? reg.expectedDurationBars.toFixed(0) : '∞'} bars
              </span>
            )}
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <LineChart
                height={170}
                series={[
                  { name: 'returns (color = decoded state)', points: rets.map((r, i) => ({ x: i, y: r })), color: '#52525b', dot: true },
                ]}
                xLabel="bar"
                yLabel="per-bar return"
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {fit?.states.map((s, i) => (
                  <span key={i} className="rounded bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[9px] text-zinc-300 ring-1 ring-zinc-700/60">
                    state {i}: {s.label} σ{(s.sigma * 100).toFixed(2)} · π={(s.stationaryProb * 100).toFixed(0)}% · E[run]={Number.isFinite(s.expectedDurationBars) ? s.expectedDurationBars.toFixed(0) : '∞'}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">transition matrix A</p>
              <table className="mt-1 w-full font-mono text-[9px]">
                <tbody>
                  {fit?.trans.map((row, i) => (
                    <tr key={i}>
                      <td className="pr-1 text-zinc-500">{i}</td>
                      {row.map((v, j) => (
                        <td key={j} className="px-1 py-0.5" style={{ color: v > 0.8 ? '#2dd4bf' : v > 0.15 ? '#a78bfa' : '#71717a' }}>
                          {v.toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 space-y-1">
                <Readout items={[{ label: 'state recovery vs truth', value: `${(matchPct * 100).toFixed(0)}%`, tone: (matchPct > 0.7 ? 'teal' : 'amber') as 'teal' | 'amber' }]} />
              </div>
            </div>
          </div>
          <CourseNote parts="the statistical machine" idea="Three hidden markets live in one return series — calm, trending, violent. Baum–Welch never sees the states; it infers them from the SHAPE of the distribution, then tells you which one you are in with a probability." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 4 · GARCH vol machine ─────────────────────────────────────────────────── */

function clusteredReturns(seed: number, n: number): number[] {
  // seeded persistent-variance generator (the thing GARCH exists to find)
  let s = seed >>> 0;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
  let v = 0.0004;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    v = 0.0002 + 0.93 * v;
    out.push(Math.sqrt(v) * gauss());
  }
  return out;
}

export function GarchVolModel() {
  const [seed, setSeed] = useState(7);
  const [alphaTrue, setAlphaTrue] = useState(0.06);

  const { fit, fc, condTail, fcPath } = useMemo(() => {
    const rets = clusteredReturns(seed + Math.round(alphaTrue * 1000), 600).map((r) => r * (alphaTrue / 0.06));
    const f = fitGarch(rets, { barsPerYear: 35_040 });
    if (!f) return { fit: null, fc: null, condTail: [], fcPath: [] };
    const g = garchForecast(f, rets[rets.length - 1], 48);
    const bp = 96; // bars per day
    const condTail = f.volTail.map((v, i) => ({ x: -60 + i, y: v * Math.sqrt(35_040) * 100 }));
    const fcPath = g.volPctAnnual.map((v, i) => ({ x: i, y: v }));
    return { fit: f, fc: g, condTail, fcPath };
  }, [seed, alphaTrue]);

  return (
    <Dock viewId="models-garch">
      <DockPanel id="garch-machine" title="GARCH(1,1) — volatility that remembers" span={2}>
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <RerollButton seed={seed} onSeed={() => setSeed((s) => s + 1)} />
            <div className="w-56">
              <ParamSlider label="true news weight α" value={alphaTrue} min={0.02} max={0.3} step={0.01} onChange={setAlphaTrue} format={(v) => v.toFixed(2)} />
            </div>
          </div>
          <LineChart
            height={170}
            series={[
              { name: 'conditional σ (last 60 bars)', points: condTail, color: '#2dd4bf' },
              { name: 'h-step forecast σ % (annualized)', points: fcPath, color: '#a78bfa', dashed: true },
              ...(fit ? [{ name: 'long-run σ', points: [{ x: -60, y: fit.longRunVol * Math.sqrt(35_040) * 100 }, { x: 48, y: fit.longRunVol * Math.sqrt(35_040) * 100 }], color: '#71717a', dashed: true }] : []),
            ]}
            xLabel="bars (past ← → future)"
            yLabel="σ %"
          />
          {fit && (
            <Readout
              items={[
                { label: 'α̂ (news)', value: fit.alpha.toFixed(3), tone: 'teal' },
                { label: 'β̂ (memory)', value: fit.beta.toFixed(3), tone: 'teal' },
                { label: 'persistence α+β', value: fit.persistence.toFixed(3), tone: (fit.persistence > 0.97 ? 'rose' : 'amber') as 'rose' | 'amber' },
                { label: 'σ now', value: `${(fit.currentVol * Math.sqrt(35_040) * 100).toFixed(1)}%` },
                { label: 'σ @48 bars', value: `${(fc?.volPctAnnual[47] ?? 0).toFixed(1)}%`, tone: 'zinc' },
                { label: 'shock half-life', value: fit.shockHalfLifeBars ? `${fit.shockHalfLifeBars.toFixed(0)} bars` : '∞', tone: 'amber' as const },
              ]}
            />
          )}
          <CourseNote parts="the statistical machine" idea="Yesterday's squared return is today's variance: ω + α·ε² + β·σ². The forecast is a rubber band pulling to the long run at rate (α+β) — watch half-life explode as persistence → 1." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 5 · Kalman trend + OU spring ──────────────────────────────────────────── */

export function KalmanOuModel() {
  const [seed, setSeed] = useState(21);
  const [noise, setNoise] = useState(3);

  const { ramp, kal, verdict, ouFit, stretch, decay } = useMemo(() => {
    const rng = mulberry32(seed >>> 0);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
    const ramp: number[] = [];
    let x = 0;
    for (let t = 0; t < 400; t++) {
      x = 0.6 * x + gauss() * 0.5; // mean-reverting truth
      ramp.push(100 + x + gauss() * noise);
    }
    const kal = kalmanTrend(ramp);
    // per-bar σ of the price diffs (the honest z-scale for the slope)
    const diffs: number[] = [];
    for (let i = 1; i < ramp.length; i++) diffs.push(ramp[i] - ramp[i - 1]);
    const dm = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sigma = Math.sqrt(diffs.reduce((a, b) => a + (b - dm) ** 2, 0) / Math.max(1, diffs.length - 1)) || 1e-6;
    const verdict = kal ? kalmanVerdict(kal, sigma) : null;
    const logRamp = ramp.map((p) => Math.log(p));
    const ouFit = fitOu(logRamp);
    const stretch = ouFit ? ouStretch(ouFit, logRamp[logRamp.length - 1]) : null;
    return { ramp, kal, verdict, ouFit, stretch, decay: stretch?.expectedDecayBars ?? [] };
  }, [seed, noise]);

  return (
    <Dock viewId="models-kalman">
      <DockPanel id="kalman-filter" title="The honest trend (Kalman) + the rubber band (OU)" span={2}>
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <RerollButton seed={seed} onSeed={() => setSeed((s) => s + 1)} />
            <div className="w-56">
              <ParamSlider label="observation noise" value={noise} min={0.5} max={10} step={0.5} onChange={setNoise} format={(v) => v.toFixed(1)} />
            </div>
            {verdict && <span className="font-mono text-[10px] text-teal-300">trend {verdict.label} · z={verdict.z.toFixed(2)}σ</span>}
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            <LineChart
              height={160}
              series={[
                { name: 'price', points: ramp.map((p, i) => ({ x: i, y: p })), color: '#52525b', dot: true },
                ...(kal ? [{ name: 'Kalman level', points: kal.level.map((l, i) => ({ x: i, y: l })), color: '#2dd4bf' }] : []),
              ]}
              xLabel="bar"
              yLabel="level"
            />
            <LineChart
              height={160}
              series={[
                { name: 'OU expected decay from here', points: decay.map((v, i) => ({ x: i + 1, y: v })), color: '#a78bfa', dashed: true },
                ...(ouFit ? [{ name: 'θ (pull level)', points: [{ x: 1, y: ouFit.theta }, { x: 30, y: ouFit.theta }], color: '#71717a', dashed: true }] : []),
              ]}
              xLabel="bars ahead"
              yLabel="log level"
            />
          </div>
          <Readout
            items={[
              ...(verdict ? [{ label: 'Kalman verdict', value: verdict.label, tone: (verdict.label === 'UP' ? 'teal' : verdict.label === 'DOWN' ? 'rose' : 'zinc') as 'teal' | 'rose' | 'zinc' }] : []),
              ...(verdict ? [{ label: 'slope z / stability', value: `${verdict.z.toFixed(2)}σ / ${(verdict.stability * 100).toFixed(0)}%` }] : []),
              ...(ouFit
                ? [
                    { label: 'OU φ', value: ouFit.phi.toFixed(4), tone: 'teal' as const },
                    { label: 'half-life', value: ouFit.halfLifeBars ? `${ouFit.halfLifeBars.toFixed(0)} bars` : '∞', tone: 'amber' as const },
                    { label: 'stretch now', value: `${(stretch?.z ?? 0).toFixed(1)}σ`, tone: (Math.abs(stretch?.z ?? 0) > 2 ? 'rose' : 'zinc') as 'rose' | 'zinc' },
                    { label: 'reversion score', value: `${ouFit.score}/100` },
                  ]
                : []),
            ]}
          />
          <CourseNote parts="the statistical machine" idea="The Kalman filter is the trend you can trust: every observation is split between 'news' and 'noise' by the innovation variance. The OU half-life then tells you how long a stretched deviation takes to earn its way back." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 6 · ML lab ────────────────────────────────────────────────────────────── */

export function MlLabModel() {
  const [seed, setSeed] = useState(31);
  const [sep, setSep] = useState(0.25);

  const { pts, boundary, log, forest, ridge } = useMemo(() => {
    const rng = mulberry32(seed >>> 0);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
    const xs: Float64Array[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = gauss();
      const b = gauss();
      xs.push(new Float64Array([a, b]));
      ys.push(a + b * 0.6 > sep * 2 ? 1 : 0);
    }
    const cut = Math.floor(xs.length * 0.7);
    const model = trainLogistic(xs.slice(0, cut), ys.slice(0, cut), { seed: 1 });
    const ev = model ? logisticEvaluate(model, xs.slice(cut), ys.slice(cut)) : null;
    const fo = miniForest(xs, ys, { nTrees: 9, depth: 3, seed: 5 });
    const rBeta = solveRidge(xs, ys.map((y) => (y > 0 ? 1 : 0)), 0.1);
    const pts = xs.map((row, i) => ({ x: row[0], y: row[1], cls: ys[i] }));
    const boundary = model
      ? Array.from({ length: 40 }, (_, i) => {
          const x = -2.5 + (i * 5) / 39;
          const zX = (x - model.mu[0]) / model.sd[0];
          const zY = -(model.w[0] * zX + model.b) / Math.max(1e-9, model.w[1]);
          const y = zY * model.sd[1] + model.mu[1];
          return { x, y };
        })
      : [];
    return { pts, boundary, log: { model, ev }, forest: fo, ridge: rBeta };
  }, [seed, sep]);

  return (
    <Dock viewId="models-ml">
      <DockPanel id="ml-lab" title="The learning machine — P(up) classifiers on synthetic flow" span={2}>
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <RerollButton seed={seed} onSeed={() => setSeed((s) => s + 1)} />
            <div className="w-56">
              <ParamSlider label="class separability" value={sep} min={0} max={1.2} step={0.05} onChange={setSep} format={(v) => v.toFixed(2)} />
            </div>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            <LineChart
              height={170}
              series={[
                { name: 'class 0', points: pts.filter((p) => p.cls === 0).map((p) => ({ x: p.x, y: p.y })), color: '#f43f5e', dot: true },
                { name: 'class 1 (up)', points: pts.filter((p) => p.cls === 1).map((p) => ({ x: p.x, y: p.y })), color: '#2dd4bf', dot: true },
                ...(boundary.length ? [{ name: 'learned boundary', points: boundary, color: '#a78bfa', dashed: true }] : []),
              ]}
              xLabel="feature 1 (momentum)"
              yLabel="feature 2 (vol regime)"
            />
            <div className="space-y-2">
              <StatGrid
                cols={2}
                stats={[
                  { label: 'logistic holdout acc', value: log.ev ? `${(log.ev.accuracy * 100).toFixed(1)}%` : '—', tone: 'teal' as const },
                  { label: 'AUC', value: log.ev?.auc != null ? log.ev.auc.toFixed(2) : '—' },
                  { label: 'log loss', value: log.ev ? log.ev.logLoss.toFixed(3) : '—' },
                  { label: 'forest OOB', value: forest?.oobAccuracy != null ? `${(forest.oobAccuracy * 100).toFixed(1)}%` : '—', tone: 'amber' as const },
                  { label: 'ridge β₁', value: ridge ? ridge[0].toFixed(2) : '—' },
                  { label: 'ridge β₂', value: ridge ? ridge[1].toFixed(2) : '—' },
                ]}
              />
              {forest && (
                <Readout
                  items={[
                    {
                      label: 'forest vote on a hot bar (+2σ, calm)',
                      value: `${(forestPredict(forest, new Float64Array([2, -0.5])).p * 100).toFixed(0)}% up`,
                      tone: 'teal' as const,
                    },
                  ]}
                />
              )}
            </div>
          </div>
          <CourseNote parts="the statistical machine" idea="The market's P(up) is learned, not assumed: logistic regression draws the boundary the tape implies, the forest votes with 9 bagged trees, and the walk-forward split is the honesty — training always happens in the past." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 7 · Portfolio Kelly ──────────────────────────────────────────────────── */

export function PortfolioKellyModel() {
  const [winP, setWinP] = useState(55);
  const [winR, setWinR] = useState(0.2);
  const [lossR, setLossR] = useState(0.15);

  const { curve, k, tr, rp, dd } = useMemo(() => {
    const rng = mulberry32(12345);
    const rets: number[] = [];
    for (let i = 0; i < 600; i++) rets.push(rng() < winP / 100 ? winR : -lossR);
    const k = kellyFraction(rets, 1);
    const curve: { x: number; y: number }[] = [];
    for (let i = 0; i <= 60; i++) {
      const f = i / 40;
      const g = kellyGrowth(rets, f);
      curve.push({ x: f, y: Number.isFinite(g) ? g : -0.02 });
    }
    const tr = tailRisk(rets, 0.95);
    const rp = riskParity([0.8, 0.4, 0.25]);
    const dd = drawdown(rets);
    return { curve, k, tr, rp, dd };
  }, [winP, winR, lossR]);

  return (
    <Dock viewId="models-kelly">
      <DockPanel id="kelly-machine" title="The growth-optimal fraction — and its cliff" span={2}>
        <div className="space-y-2 p-3">
          <div className="grid grid-cols-3 gap-x-4">
            <ParamSlider label="win probability" value={winP} min={35} max={70} step={1} onChange={setWinP} format={(v) => `${v.toFixed(0)}%`} />
            <ParamSlider label="win size" value={winR} min={0.05} max={0.6} step={0.01} onChange={setWinR} format={(v) => `+${(v * 100).toFixed(0)}%`} />
            <ParamSlider label="loss size" value={lossR} min={0.05} max={0.6} step={0.01} onChange={setLossR} format={(v) => `−${(v * 100).toFixed(0)}%`} />
          </div>
          <LineChart
            height={170}
            series={[
              { name: 'g(f) = E[ln(1+f·r)]', points: curve, color: '#2dd4bf' },
              ...(k ? [{ name: 'f*', points: [{ x: k.f, y: Math.min(...curve.map((c) => c.y)) }, { x: k.f, y: Math.max(...curve.map((c) => c.y)) }], color: '#a78bfa', dashed: true }] : []),
              ...(k ? [{ name: 'half-Kelly (the desk rule)', points: [{ x: k.fHalf, y: Math.min(...curve.map((c) => c.y)) }, { x: k.fHalf, y: Math.max(...curve.map((c) => c.y)) }], color: '#f43f5e', dashed: true }] : []),
            ]}
            xLabel="fraction of book f"
            yLabel="expected log growth per trade"
          />
          <div className="grid gap-2 lg:grid-cols-2">
            {k && (
              <Readout
                items={[
                  { label: 'f* (discrete)', value: `${(k.f * 100).toFixed(1)}%`, tone: 'teal' as const },
                  { label: 'half-Kelly', value: `${(k.fHalf * 100).toFixed(1)}%`, tone: 'amber' as const },
                  { label: 'growth at f*', value: k.growth.toFixed(4), tone: 'teal' as const },
                  { label: 'continuous μ/σ²', value: k.fContinuous != null ? `${(k.fContinuous * 100).toFixed(1)}%` : '—' },
                ]}
              />
            )}
            {tr && (
              <Readout
                items={[
                  { label: 'VaR 95', value: fmtPctSigned(tr.varHist * 100, 1), tone: 'rose' },
                  { label: 'CVaR 95', value: fmtPctSigned(tr.cvarHist * 100, 1), tone: 'rose' },
                  { label: 'risk parity weights', value: rp ? rp.weights.map((w) => `${(w * 100).toFixed(0)}%`).join(' / ') : '—', tone: 'zinc' },
                  { label: 'max drawdown', value: `${(dd.maxDd * 100).toFixed(1)}%`, tone: 'amber' as const },
                ]}
              />
            )}
          </div>
          <CourseNote parts="the statistical machine" idea="Kelly is the only sizing rule that respects both your edge and your ruin: below f* growth compounds, above it the log goes negative and the path dies. The desk trades half-Kelly because the edge is estimated, not known." />
        </div>
      </DockPanel>
    </Dock>
  );
}

/** ── 8 · LIVE model room (the integration showcase) ───────────────────────── */

interface SuiteModel {
  id: string;
  label: string;
  kind: string;
  params: { label: string; value: number | string | null }[];
  series: { name: string; points: number[] }[];
  verdict: string;
  consumedBy: string[];
}

interface SuiteResponse {
  ok: boolean;
  suite?: { asset: string; bars: number; klineSource: string; spot: number; models: SuiteModel[] };
  error?: string;
}

export function LiveModelRoomModel() {
  const [asset, setAsset] = useState<'BTC' | 'ETH' | 'SOL'>('BTC');
  const [data, setData] = useState<SuiteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await fetch(`/api/decision/models?asset=${asset}`, { cache: 'no-store', signal: ctl.signal });
      const body = (await res.json()) as SuiteResponse;
      if (!res.ok || !body.ok) throw new Error(body.error ?? `model suite ${res.status}`);
      setData(body);
      setError(null);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [asset]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [load]);

  const suite = data?.suite;

  return (
    <Dock viewId="models-live">
      <DockPanel id="live-room" title="The LIVE room — every model fitted on real bars, and where it feeds" span={2}>
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {(['BTC', 'ETH', 'SOL'] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAsset(a)}
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${a === asset ? 'bg-teal-950 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {a}
              </button>
            ))}
            <button onClick={() => void load()} className="ml-2 text-zinc-400 hover:text-zinc-200" title="refresh">
              <RefreshCw className="h-3 w-3" />
            </button>
            {loading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
            {suite && (
              <span className="ml-auto font-mono text-[9px] text-zinc-500">
                {suite.bars} bars ({suite.klineSource}) · spot {suite.spot < 10 ? suite.spot.toFixed(3) : suite.spot.toFixed(0)}
              </span>
            )}
          </div>
          <PanelState loading={loading && !suite} error={error} empty={!suite && !loading ? 'model suite unavailable' : null} onRetry={() => void load()} skeletonRows={8}>
            {suite && (
              <div className="grid gap-2 lg:grid-cols-2">
                {suite.models.map((m) => (
                  <div key={m.id} className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 p-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] font-bold tracking-wide text-teal-300">{m.label}</span>
                      <span className="text-[8px] uppercase tracking-wider text-zinc-600">{m.kind}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] font-semibold text-zinc-200">{m.verdict}</p>
                    {m.series.length > 0 && m.series[0].points.length > 1 && (
                      <LineChart
                        height={80}
                        series={m.series.slice(0, 3).map((s, i) => ({
                          name: s.name,
                          points: s.points.map((v, j) => ({ x: j, y: v })),
                          color: ['#2dd4bf', '#a78bfa', '#71717a'][i % 3],
                        }))}
                      />
                    )}
                    {m.params.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[8px] text-zinc-500">
                        {m.params.slice(0, 6).map((p, i) => (
                          <span key={i}>
                            {p.label} <span className="font-mono text-zinc-300">{p.value != null ? p.value : '—'}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {m.consumedBy.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-zinc-800/60 pt-1.5">
                        <span className="text-[8px] uppercase tracking-wider text-zinc-600">feeds</span>
                        {m.consumedBy.map((c) => (
                          <span key={c} className="rounded bg-sky-950/50 px-1 py-0.5 text-[8px] text-sky-300 ring-1 ring-sky-800/50" title={c}>
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </PanelState>
          <CourseNote parts="the statistical machine · live" idea="This is the deep-integration map: every model on this page is fitted on the same live bar history the whole terminal shares — and the FEEDS chips tell you which product surfaces already consume it: the Decision Hub pillars, the forecast regime block, the autopilot stance gate, the strategy fit, the morning brief." />
        </div>
      </DockPanel>
    </Dock>
  );
}
