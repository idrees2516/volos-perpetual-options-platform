'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · panels-volatility — the surface as an object (Part 12):
//   svi-surface  — sculpt the whole implied-vol surface with SVI slices hung
//                  on a term structure (shared ρ, wing strength λ) — with the
//                  butterfly-arbitrage region glowing where g(k) < 0 and the
//                  calendar check running live
//   dupire       — the local-vol surface a skewed market actually implies —
//                  Dupire's formula in total-variance form, computed live
//   varswap      — the 1/K² strip: the log contract's fair variance from the
//                  surface's OTM options — the VIX recipe, per slice
//   surface-pca  — how the surface MOVES: the three eigen-surfaces (level
//                  breathing, term twist, skew tilt) with explained variance
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { Surface3d } from './surface3d';
import { ParamSlider, CourseNote, Readout } from './models-ui';
import { StatGrid } from '@/components/terminal/quantlab/quant-viz';
import {
  buildSurface, sviIV, sviG, calendarCheck, leeWing, dupireGrid, varSwapStrike, jwParams,
} from '@/lib/models/volsurface';
import { surfacePCA } from '@/lib/models/market';
import { fmtNum } from '@/lib/format';

const KGRID = Array.from({ length: 25 }, (_, i) => -0.45 + (i * 0.9) / 24);
const EXPIRIES = [0.083, 0.25, 0.5, 1.0, 2.0];

// ── SVI surface with live arbitrage checks ─────────────────────────────────

export function SviSurfaceModel() {
  const [atmVol, setAtmVol] = useState(0.45);
  const [termSlope, setTermSlope] = useState(0.05);
  const [rho, setRho] = useState(-0.7);
  const [skew, setSkew] = useState(0.3);
  const [m, setM] = useState(0);
  const [si, setSi] = useState(0.35);

  const { surface, iv, gsurf, calendar, wing } = useMemo(() => {
    const atmVols = EXPIRIES.map((T) => atmVol + termSlope * T);
    const surface = buildSurface({ S: 100, r: 0.05, q: 0, atmVols, rho, skew, m, si, expiries: EXPIRIES });
    // iv[xi][Ti]
    const iv = KGRID.map((k) => EXPIRIES.map((T) => sviIV(k, T, surface.slices.find((s) => Math.abs(s.T - T) < 1e-9)!.p)));
    // g(k) surface (butterfly detector)
    const gsurf = KGRID.map((k) => EXPIRIES.map((T) => sviG(k, surface.slices.find((s) => Math.abs(s.T - T) < 1e-9)!.p)));
    const calendar = calendarCheck(surface, KGRID);
    // Lee wings of the longest slice
    const wing = leeWing(surface.slices[surface.slices.length - 1].p);
    return { surface, iv, gsurf, calendar, wing };
  }, [atmVol, termSlope, rho, skew, m, si]);

  const arbCells = gsurf.flat().filter((g) => Number.isFinite(g) && g < 0).length;
  const jw = jwParams(surface.slices[2].p, surface.slices[2].T);

  return (
    <Dock viewId="models-svi" layout="grid">
      <DockPanel id="surface" title="The volatility surface · SVI slices hung on a term structure" sub="σ(k, T) — one tilt ρ, one wing strength λ, θ(T) rising on the floor" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: KGRID, y: EXPIRIES, z: iv }, mode: 'height' }]}
            xLabel="log-moneyness k"
            yLabel="expiry T (y)"
            zLabel="implied vol"
            height={320}
            formatZ={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Readout
            items={[
              { label: 'butterfly-arb cells (g<0)', value: `${arbCells} / ${gsurf.flat().length}`, tone: arbCells > 0 ? 'rose' : 'teal' },
              { label: 'calendar arb', value: calendar.ok ? 'clean' : `w(k=${calendar.worstPair?.k.toFixed(2)}) ∂w/∂T < 0`, tone: calendar.ok ? 'teal' : 'rose' },
              { label: 'Lee β_L / β_R', value: `${fmtNum(wing.betaLeft, 3)} / ${fmtNum(wing.betaRight, 3)}`, tone: wing.betaLeft > 2 || wing.betaRight > 2 ? 'rose' : 'teal' },
              { label: 'implied moments p̃ / q̃', value: `${fmtNum(wing.pRight, 2)} / ${fmtNum(wing.qLeft, 2)}` },
            ]}
          />
          <CourseNote
            parts="Part 12 ch2–5 · Gatheral 2004"
            idea="w(k) = a + b[ρ(k−m) + √((k−m)²+σ²)] — five numbers a desk actually quotes per slice. Shared ρ and b(T) = λ√θ(T) make ATM skew decay like 1/√T. Push λ past the butterfly bound and the NEGATIVE density region appears — a smile you'd be paid to butterfly."
          />
        </div>
      </DockPanel>
      <DockPanel id="arb" title="Gatheral's g(k) · the butterfly-arbitrage detector" sub="g < 0 ⇒ a negative risk-neutral density ⇒ arbitrage — the red valley" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: KGRID, y: EXPIRIES, z: gsurf }, mode: 'height' }]}
            xLabel="log-moneyness k"
            yLabel="expiry T (y)"
            zLabel="g(k)"
            height={230}
            formatZ={(v) => fmtNum(v, 2)}
          />
          <CourseNote
            parts="Part 12 ch3 · Gatheral–Jacquier 2014"
            idea="g = (1 − k w'/2w)² − (w'/2)²(1/w + ¼) + w''/2. A harmless-looking smile can hide a negative density (Vogt's lesson): the check is cheap and the region glows here the moment your wings get too steep."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Sculpt the surface" span={1}>
        <div className="space-y-3">
          <ParamSlider label="ATM vol (front)" value={atmVol} min={0.15} max={1.2} step={0.05} onChange={setAtmVol} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="term slope" value={termSlope} min={-0.3} max={0.3} step={0.01} onChange={setTermSlope} format={(v) => `${(v * 100).toFixed(0)}%/y`} hint="contango (+) or backwardation (−)" />
          <ParamSlider label="tilt ρ" value={rho} min={-1} max={1} step={0.05} onChange={setRho} hint="−1: put wing steep · +1: call wing steep" />
          <ParamSlider label="wing strength λ" value={skew} min={0} max={1.2} step={0.05} onChange={setSkew} hint="b(T) = λ√θ(T) — past ~0.5 the butterfly arbitrage region appears" />
          <ParamSlider label="center m" value={m} min={-0.3} max={0.3} step={0.01} onChange={setM} />
          <ParamSlider label="vertex rounding σ" value={si} min={0.05} max={1} step={0.05} onChange={setSi} />
        </div>
      </DockPanel>
      <DockPanel id="jw" title="The trader's five numbers · JW view (90d slice)" span={1}>
        <StatGrid
          cols={2}
          stats={[
            { label: 'v (ATM variance)', value: fmtNum(jw.v * 10000, 1), sub: 'σ²_ATM annualised ×10⁴' },
            { label: 'ψ (ATM skew)', value: fmtNum(jw.psi, 3) },
            { label: 'p (put wing)', value: fmtNum(jw.p, 3) },
            { label: 'c (call wing)', value: fmtNum(jw.c, 3) },
            { label: 'ṽ (min variance)', value: fmtNum(jw.vTilde * 10000, 1) },
            { label: 'Lee bound', value: `b(1+|ρ|) ≤ 2`, sub: 'moment p̃ = (2−β)²/(8β) per wing' },
          ]}
        />
        <CourseNote parts="Part 12 ch4 · Zeliade 2009" idea="The same slice in the language desks quote: ATM variance, ATM skew, put/call wing slopes, minimum variance. RR loads on vanna, BF on volga — the market's prices of the second-order Greeks." />
      </DockPanel>
    </Dock>
  );
}

// ── Dupire local vol ───────────────────────────────────────────────────────

export function DupireModel() {
  const [rho, setRho] = useState(-0.7);
  const [skew, setSkew] = useState(0.25);
  const [atmVol, setAtmVol] = useState(0.45);

  const { lv, atmIV } = useMemo(() => {
    const atmVols = EXPIRIES.map(() => atmVol);
    const surface = buildSurface({ S: 100, r: 0.05, q: 0, atmVols, rho, skew, m: 0, si: 0.4, expiries: EXPIRIES });
    const grid = dupireGrid(surface, KGRID);
    // transpose into [xi][Ti]: dupireGrid returns lv[row=T][k]
    const Ts = grid.T;
    const lv = KGRID.map((_, ki) => Ts.map((_, ti) => grid.lv[ti][ki] ?? NaN));
    const atmIV = sviIV(0, 0.25, surface.slices[1].p);
    return { lv, atmIV };
  }, [rho, skew, atmVol]);

  const flat = lv.flat().filter((v) => Number.isFinite(v));

  return (
    <Dock viewId="models-dupire" layout="grid">
      <DockPanel id="lv" title="The local-volatility surface a skewed market implies" sub="Dupire: σ_loc²(k, T) = ∂w/∂T / [1 − (k/w)w' + (w'²/4)(−¼ − 1/w + k²/w²) + w''/2]" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: KGRID, y: EXPIRIES.slice(1), z: lv }, mode: 'height' }]}
            xLabel="log-moneyness k"
            yLabel="expiry T (y)"
            zLabel="local vol"
            height={320}
            formatZ={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Readout
            items={[
              { label: 'ATM implied (90d)', value: `${(atmVol * 100).toFixed(0)}%`, tone: 'zinc' },
              { label: 'local vol range', value: `${(Math.min(...flat) * 100).toFixed(0)}% … ${(Math.max(...flat) * 100).toFixed(0)}%`, tone: 'teal' },
              { label: 'skew handed down', value: 'the smile of fear becomes the DYNAMICS of fear' },
            ]}
          />
          <CourseNote
            parts="Part 12 ch6–8 · Dupire 1994 · Derman–Kani 1994"
            idea="Given TODAY's surface, local vol is the unique diffusion that reproduces it: σ_loc is the instantaneous vol the market believes in at each (K, T). Its famous flaw: under local vol the FORWARD smile moves the wrong way (SSR = 2 ⇒ sticky-doubling) — why desks moved to stochastic vol."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Implied surface shape" span={1}>
        <div className="space-y-3">
          <ParamSlider label="ATM vol" value={atmVol} min={0.15} max={1.2} step={0.05} onChange={setAtmVol} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="tilt ρ (skew)" value={rho} min={-1} max={1} step={0.05} onChange={setRho} />
          <ParamSlider label="wing strength λ" value={skew} min={0} max={0.9} step={0.05} onChange={setSkew} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'flat surface check', value: 'σ_loc = σ', sub: 'the flat case reproduces itself — the formula\'s sanity anchor' },
              { label: 'forward smile', value: 'wrong way', sub: 'Bergomi: LV\'s forward smile is roughly doubled — SSR = 2' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the variance swap strip ─────────────────────────────────────────────────

export function VarSwapModel() {
  const [rho, setRho] = useState(-0.6);
  const [skew, setSkew] = useState(0.2);
  const [atmVol, setAtmVol] = useState(0.45);

  const { kv, atmIV, ts } = useMemo(() => {
    const surface = buildSurface({
      S: 100, r: 0.05, q: 0,
      atmVols: EXPIRIES.map(() => atmVol),
      rho, skew, m: 0, si: 0.4, expiries: EXPIRIES,
    });
    const kv = EXPIRIES.map((T) => varSwapStrike(100, T, 0.05, 0, surface.slices.find((s) => Math.abs(s.T - T) < 1e-9)!.p));
    const atmIV = EXPIRIES.map((T) => sviIV(0, T, surface.slices.find((s) => Math.abs(s.T - T) < 1e-9)!.p));
    return { kv, atmIV, ts: EXPIRIES };
  }, [rho, skew, atmVol]);

  const vrps = kv.map((k, i) => (k * k - atmIV[i] * atmIV[i]) * 10000);

  return (
    <Dock viewId="models-varswap" layout="grid">
      <DockPanel id="strip" title="The 1/K² strip · variance swap fair strike by expiry" sub="K_var² = (2/T)e^{rT}∫ OTM(K)/K² dK — the VIX recipe per slice" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: [0], y: ts, z: kv.map((v) => [v]) }, mode: 'height' }]}
            paths={[{ points: kv.map((v, i) => ({ x: 0, y: ts[i], z: v })), color: '#2dd4bf', width: 2.4, headDot: true }]}
            xLabel="k = 0 (the strip collapsed to ATM)"
            yLabel="expiry T (y)"
            zLabel="K_var (fair vol)"
            height={260}
            formatZ={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Readout
            items={ts.map((T, i) => ({
              label: `T=${T}y`,
              value: `K_var ${(kv[i] * 100).toFixed(1)}% · ATM ${(atmIV[i] * 100).toFixed(1)}% · convexity ${fmtNum(vrps[i], 0)}`,
              tone: kv[i] > atmIV[i] ? 'teal' : 'zinc',
            }))}
          />
          <CourseNote
            parts="Part 12 ch9–11 · Demeterfi–Derman–Kamal–Zou 1999 · Neuberger 1994"
            idea="The log contract replicates variance exactly: weight every OTM option by 1/K². K_var > ATM vol is the STRIP's convexity — the wings' variance the VIX buys. Flat σ ⇒ K_var = σ exactly (the lab's own test)."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Surface shape" span={1}>
        <div className="space-y-3">
          <ParamSlider label="ATM vol" value={atmVol} min={0.15} max={1.2} step={0.05} onChange={setAtmVol} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="tilt ρ" value={rho} min={-1} max={1} step={0.05} onChange={setRho} />
          <ParamSlider label="wing strength λ" value={skew} min={0} max={0.9} step={0.05} onChange={setSkew} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'K_var vs ATM', value: 'convexity', sub: 'the variance-risk premium\'s tradable skeleton (Carr–Wu 2009)' },
              { label: 'VIX recipe', value: '30d SPX strip', sub: 'the same integral, discretised over listed strikes, ×100 = the index' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── how the surface moves: PCA ──────────────────────────────────────────────

export function SurfacePcaModel() {
  const [seed, setSeed] = useState(21);

  const pca = useMemo(() => {
    const kGrid = [-0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    const TGrid = [0.083, 0.25, 0.5, 1, 2];
    return surfacePCA(seed, { weeks: 60, kGrid, TGrid });
  }, [seed]);

  // reshape eigen components into surfaces: cell c ↔ (T_i, k_j), outer T inner k
  const toSurface = (vec: number[]) => {
    const nk = 9;
    const nT = 5;
    const z: number[][] = [];
    for (let j = 0; j < nk; j++) {
      const row: number[] = [];
      for (let i = 0; i < nT; i++) row.push(vec[i * nk + j]);
      z.push(row);
    }
    return z;
  };
  const kAxis = [-0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
  const TAxis = [0.083, 0.25, 0.5, 1, 2];

  return (
    <Dock viewId="models-pca" layout="grid">
      <DockPanel id="pc1" title="PC1 · the level breathes" sub={`explained variance ${(pca.explained[0] * 100).toFixed(1)}%`} span={1}>
        <Surface3d surfaces={[{ data: { x: kAxis, y: TAxis, z: toSurface(pca.eigen[0]) }, mode: 'height' }]} xLabel="k" yLabel="T (y)" zLabel="eigen (log-vol)" height={240} />
      </DockPanel>
      <DockPanel id="pc2" title="PC2 · the term twist" sub={`explained variance ${(pca.explained[1] * 100).toFixed(1)}%`} span={1}>
        <Surface3d surfaces={[{ data: { x: kAxis, y: TAxis, z: toSurface(pca.eigen[1]) }, mode: 'height' }]} xLabel="k" yLabel="T (y)" zLabel="eigen (log-vol)" height={240} />
      </DockPanel>
      <DockPanel id="pc3" title="PC3 · the skew tilt" sub={`explained variance ${(pca.explained[2] * 100).toFixed(1)}%`} span={1}>
        <Surface3d surfaces={[{ data: { x: kAxis, y: TAxis, z: toSurface(pca.eigen[2]) }, mode: 'height' }]} xLabel="k" yLabel="T (y)" zLabel="eigen (log-vol)" height={240} />
      </DockPanel>
      <DockPanel id="notes" title="How surfaces move" span={1}>
        <div className="space-y-3">
          <Readout
            items={[
              { label: 'PC1+PC2+PC3', value: `${((pca.explained[0] + pca.explained[1] + pca.explained[2]) * 100).toFixed(1)}% of moves` },
              { label: 'short end', value: 'moves most' },
              { label: 'seed', value: seed },
            ]}
          />
          <button
            onClick={() => setSeed(Math.floor(Math.random() * 9999))}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[9px] uppercase tracking-wider text-zinc-400 transition hover:border-teal-700/60 hover:text-teal-300"
          >
            re-roll 60 weeks
          </button>
          <CourseNote
            parts="Part 12 ch2 · Cont–da Fonseca 2002"
            idea="PCA of weekly surface moves: PC1 lifts everything (level), PC2 rocks the term structure (twist), PC3 tilts the skew — three shapes explain ~95% of how a surface moves, the base of every vol book's hedging tree."
          />
        </div>
      </DockPanel>
    </Dock>
  );
}
