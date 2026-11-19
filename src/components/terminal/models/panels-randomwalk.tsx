'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · panels-randomwalk — Act I–II models:
//   random-walk  — the fair game: the P-world density fan vs the Q-world,
//                  the sqrt-of-time law Regnault measured in 1863, live
//   book-queues  — the limit order book as a 3D object: resting depth over
//                  (price × time), walls replenishing, market orders walking
//                  the book, the tape as dots on the surface
//   liquidation  — margin made visual: the reflection principle prices the
//                  probability a leveraged long touches its liquidation
//                  barrier before T — Part 2 ch4's math, as a surface over
//                  (leverage × horizon)
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { Surface3d } from './surface3d';
import { ParamSlider, CourseNote, Readout, RerollButton } from './models-ui';
import { Panel, StatGrid, Segmented } from '@/components/terminal/quantlab/quant-viz';
import { gbmFan, hitProbBelow, liquidationProb } from '@/lib/models/processes';
import { orderBook3D } from '@/lib/models/market';
import { fmtNum, fmtPctSigned } from '@/lib/format';

// ── random walk: P vs Q, the two worlds ─────────────────────────────────────

const PQRSTEPS = 60;

export function RandomWalkModel() {
  const [muP, setMuP] = useState(0.25);
  const [sigma, setSigma] = useState(0.4);
  const [r, setR] = useState(0.05);
  const [seed, setSeed] = useState(11);
  const [densityOn, setDensityOn] = useState<'both' | 'P' | 'Q'>('both');

  // lognormal density of the log-return x at horizon t, for both measures
  const { xs, ts, pDensity, qDensity, fanP, fanQ } = useMemo(() => {
    const T = 1;
    const xs = Array.from({ length: 41 }, (_, i) => -0.6 + (i * 1.2) / 40);
    const ts = Array.from({ length: 21 }, (_, i) => (i * T) / 20);
    const pDensity: number[][] = [];
    const qDensity: number[][] = [];
    const pdf = (x: number, m: number, s: number) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
    for (const x of xs) {
      const rowP: number[] = [];
      const rowQ: number[] = [];
      for (const t of ts) {
        const s = sigma * Math.sqrt(t || 1e-9);
        rowP.push(t <= 0 ? 0 : pdf(x, (muP - 0.5 * sigma * sigma) * t, s));
        rowQ.push(t <= 0 ? 0 : pdf(x, (r - 0.5 * sigma * sigma) * t, s));
      }
      pDensity.push(rowP);
      qDensity.push(rowQ);
    }
    // one seeded fan per measure — the lecture's "two worlds" prop
    // (Array.from: a TypedArray's .map returns a TypedArray — no objects!)
    const fan = (m: number) =>
      gbmFan(seed, 9, 100, T, PQRSTEPS, m, sigma).map((path) =>
        Array.from(path, (S, i) => ({ x: Math.log(S / 100), y: (i / PQRSTEPS) * T, z: 0.01 + Math.log(S / 100) * 0.05 })).filter((_, i) => i % 3 === 0),
      );
    return { xs, ts, pDensity, qDensity, fanP: fan(muP), fanQ: fan(r) };
  }, [muP, sigma, r, seed]);

  const qMean = r - 0.5 * sigma * sigma;
  const pMean = muP - 0.5 * sigma * sigma;
  const sdT = sigma;

  return (
    <Dock viewId="models-randomwalk" layout="grid">
      <DockPanel id="worlds" title="The fair game · two worlds, P and Q" sub="density of the log-return over horizon — the same market, two beliefs" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[
              ...(densityOn !== 'Q' ? [{ data: { x: xs, y: ts, z: pDensity }, mode: 'height' as const, label: 'P density (your drift μ)' }] : []),
              ...(densityOn !== 'P' ? [{ data: { x: xs, y: ts, z: qDensity }, wireframe: true, color: '#a78bfa', label: 'Q density (risk-neutral r)' }] : []),
            ]}
            paths={[
              ...fanP.map((pts, i) => ({ points: pts, color: `rgba(45,212,191,${i === 0 ? 0.9 : 0.28})`, width: 1, headDot: i === 0 })),
              ...fanQ.map((pts, i) => ({ points: pts, color: `rgba(167,139,250,${i === 0 ? 0.9 : 0.25})`, width: 1, headDot: i === 0 })),
            ]}
            xLabel="log-return x"
            yLabel="horizon t (y)"
            zLabel="density"
            height={300}
            formatZ={(v) => v.toFixed(1)}
          />
          <Readout
            items={[
              { label: 'P: E[log-return] at T', value: fmtNum(pMean, 3) },
              { label: 'Q: E[log-return] at T', value: fmtNum(qMean, 3) },
              { label: 'sd at T (√T law)', value: fmtNum(sdT, 3) },
              { label: 'P: P(S_T > S_0)', value: fmtNum(0.5 * (1 + Math.sign(pMean)), 2) },
              { label: 'Q: P(S_T > S_0)', value: fmtNum(0.5 * (1 + Math.sign(qMean)), 2) },
            ]}
          />
          <CourseNote
            parts="Part 1 ch8–9 · Part 4 · Part 10 ch4"
            idea="The risk-neutral measure Q replaces your drift μ with r so the discounted price is a martingale — the whole of derivatives pricing lives in this substitution. N(d2) is a Q-probability, not your probability."
          />
        </div>
      </DockPanel>

      <DockPanel id="controls" title="Market parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="P drift μ (your view)" value={muP} min={-0.5} max={0.6} step={0.05} onChange={setMuP} format={(v) => fmtPctSigned(v, 0)} hint="the return YOU expect — the hedger ignores it" />
          <ParamSlider label="volatility σ" value={sigma} min={0.05} max={1.2} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="Q drift r (risk-free)" value={r} min={0} max={0.15} step={0.005} onChange={setR} format={(v) => `${(v * 100).toFixed(1)}%`} />
          <Segmented
            value={densityOn}
            onChange={setDensityOn}
            options={[
              { id: 'both', label: 'both' },
              { id: 'P', label: 'P only' },
              { id: 'Q', label: 'Q only' },
            ]}
          />
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
          <StatGrid
            cols={2}
            stats={[
              { label: '√t law', value: 'σ√T', sub: 'Regnault 1863: risk grows like √time, not time — the empirical root of Bachelier' },
              { label: 'volatility drag', value: fmtNum(0.5 * sigma * sigma, 3), sub: 'the μ − σ²/2 the fan bends by — arithmetic vs geometric means' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the order book as a 3D object ───────────────────────────────────────────

export function BookQueuesModel() {
  const [sigma, setSigma] = useState(0.5);
  const [wallLevel, setWallLevel] = useState(102);
  const [wallSize, setWallSize] = useState(40);
  const [seed, setSeed] = useState(3);

  const book = useMemo(
    () => orderBook3D(seed, { S0: 100, tick: 0.25, nLevels: 25, steps: 160, sigma, wallLevel, wallSize }),
    [seed, sigma, wallLevel, wallSize],
  );

  // sample every 3rd time step for a readable mesh; transpose to [xi][yi]
  const step = 3;
  const times = book.times.filter((_, i) => i % step === 0);
  const depth: number[][] = book.prices.map((_, pi) => times.map((t) => book.depth[t][pi] ?? 0));
  const tape = book.tape.slice(-120);
  const dots = tape.map((print) => ({
    x: print.price,
    y: print.t,
    z: (book.depth[print.t]?.[book.prices.findIndex((p) => Math.abs(p - print.price) < 1e-9)] ?? 2) + 1.5,
  }));

  return (
    <Dock viewId="models-bookqueues" layout="grid">
      <DockPanel id="book3d" title="The book as queues · resting depth over price × time" sub="walls replenish, sweeps eat, the tape prints on the surface" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: book.prices, y: times, z: depth }, mode: 'height' }]}
            dots={[
              { points: dots.filter((_, i) => tape[i].side === 'buy'), color: 'rgba(45,212,191,0.9)', radius: 1.6 },
              { points: dots.filter((_, i) => tape[i].side === 'sell'), color: 'rgba(251,113,133,0.9)', radius: 1.6 },
            ]}
            xLabel="price"
            yLabel="time (steps)"
            zLabel="resting lots"
            height={300}
          />
          <Readout
            items={[
              { label: 'prints', value: book.tape.length },
              { label: 'levels', value: book.prices.length },
              { label: 'wall', value: `${fmtNum(wallLevel, 2)} × ${wallSize} lots` },
              { label: 'mid range', value: `${fmtNum(Math.min(...book.mid), 2)} … ${fmtNum(Math.max(...book.mid), 2)}` },
            ]}
          />
          <CourseNote
            parts="Part 2 ch2 · Part 36–38"
            idea="The limit order book is QUEUES: price, visibility and time precedence; the cost of walking the book; hidden orders; wholesalers and PFOF. Drag the wall level — institutional resting orders absorb the tape."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Book parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="mid volatility" value={sigma} min={0.2} max={1.5} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="wall price" value={wallLevel} min={99} max={106} step={0.25} onChange={setWallLevel} format={(v) => fmtNum(v, 2)} hint="where an institutional resting order sits" />
          <ParamSlider label="wall size (lots)" value={wallSize} min={0} max={80} step={5} onChange={setWallSize} />
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
          <Panel title="tape · last prints">
            <div className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-[8.5px]">
              {[...tape].reverse().slice(0, 24).map((p, i) => (
                <div key={i} className="flex items-center justify-between gap-3">
                  <span className={p.side === 'buy' ? 'text-teal-300' : 'text-rose-300'}>{p.side === 'buy' ? 'BUY ' : 'SELL'}</span>
                  <span className="text-zinc-300">{fmtNum(p.price, 2)}</span>
                  <span className="text-zinc-500">×{p.size.toFixed(0)}</span>
                  <span className="text-zinc-700">t{p.t}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── margin & the reflection principle ──────────────────────────────────────

export function LiquidationModel() {
  const [sigma, setSigma] = useState(0.6);
  const [mu, setMu] = useState(0.0);
  const [leverage, setLeverage] = useState(5);
  const [horizonDays, setHorizonDays] = useState(30);

  // probability surface over (leverage × horizon)
  const { leverages, days, probs } = useMemo(() => {
    const leverages = Array.from({ length: 25 }, (_, i) => 1.5 + i * 0.5);
    const days = Array.from({ length: 21 }, (_, i) => 1 + i * 14);
    const probs = leverages.map((L) => days.map((d) => liquidationProb(100, L, mu, sigma, d / 365)));
    return { leverages, days, probs };
  }, [mu, sigma]);

  const barrier = 100 * (1 - 1 / leverage);
  const p = liquidationProb(100, leverage, mu, sigma, horizonDays / 365);
  // one example path with the barrier plane
  const path = useMemo(() => gbmFan(horizonDays * 31, 1, 100, horizonDays / 365, 120, mu, sigma)[0], [mu, sigma, horizonDays]);
  const pathPts = Array.from(path, (S, i) => ({ x: i / 120, y: (i / 120) * (horizonDays / 365), z: S })).filter((_, i) => i % 2 === 0);

  return (
    <Dock viewId="models-liquidation" layout="grid">
      <DockPanel id="surface" title="Probability of liquidation · the reflection principle" sub="P(min S_t ≤ barrier) over (leverage × horizon) — closed form" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: leverages, y: days.map((d) => d / 365), z: probs } }]}
            paths={[{ points: pathPts, color: '#fbbf24', width: 1.8, headDot: true }]}
            planes={[{ axis: 'y', at: 0.5, color: 'rgba(251,113,133,1)', alpha: 0.06 }]}
            xLabel="leverage L"
            yLabel="horizon (years)"
            zLabel="P(liq)"
            height={300}
            formatZ={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Readout
            items={[
              { label: 'maintenance barrier', value: fmtNum(barrier, 1), tone: 'rose' },
              { label: `P(liquidated ≤ ${horizonDays}d)`, value: fmtNum(p, 3), tone: p > 0.5 ? 'rose' : 'teal' },
              { label: 'drift ν = μ − σ²/2', value: fmtNum(mu - 0.5 * sigma * sigma, 3) },
            ]}
          />
          <CourseNote
            parts="Part 2 ch4 · Part 41"
            idea="Margin is a barrier option you are short. The reflection principle prices P(touch) exactly for GBM — and the 1987/2008/2020 margin spirals are this surface's steep corner gone systemic: procyclicality in action."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Position parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="entry volatility σ" value={sigma} min={0.1} max={1.5} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="P drift μ" value={mu} min={-0.5} max={0.5} step={0.05} onChange={setMu} format={fmtPctSigned} />
          <ParamSlider label="leverage" value={leverage} min={1.5} max={13} step={0.5} onChange={setLeverage} format={(v) => `${v.toFixed(1)}×`} />
          <ParamSlider label="horizon (days)" value={horizonDays} min={1} max={365} step={1} onChange={setHorizonDays} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'leverage 3× · 30d', value: fmtNum(liquidationProb(100, 3, mu, sigma, 30 / 365), 3), tone: 'zinc' },
              { label: 'leverage 10× · 30d', value: fmtNum(liquidationProb(100, 10, mu, sigma, 30 / 365), 3), tone: liquidationProb(100, 10, mu, sigma, 30 / 365) > 0.3 ? 'rose' : 'zinc', sub: 'the 2021 retail corner' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}
