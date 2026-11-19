'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · panels-trading — "trading options" as a running machine
// (Part 11):
//   gamma-scalp   — the scalper's live book: option marked at implied vol,
//                    hedge at delta, path at realized vol — the ledger
//                    d(book) = ½ΓS²[(ΔS/S)² − σᵢ²Δt] filling in real time,
//                    the gamma ridge under the path, the shuffle counterfactual
//   pnl-explain   — the desk's morning waterfall: delta/gamma/theta/vega/
//                    vanna/volga/unexplained against the real revaluation
//   ww-band       — the no-trade corridor: Whalley–Wilmott's cube root of
//                    cost, Leland's frequency trade measured empirically
//   pinning       — expiry: dealer gamma pulls spot toward the strike — the
//                    distribution with and without the pin force
//   mm-inventory  — the options market maker: quoting with and without
//                    inventory skew, adverse selection eating the spread
//   strategy-shapes— every standard structure as a P&L surface over (spot, vol)
//                    that morphs across the catalog — the bets visible as shape
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { Surface3d } from './surface3d';
import { ParamSlider, CourseNote, Readout, RerollButton } from './models-ui';
import { Panel, StatGrid, Segmented, LineChart, ChartLegend, DivergingBars } from '@/components/terminal/quantlab/quant-viz';
import { hedgingLedger, shuffleLedger, pnlExplain, wwBand } from '@/lib/models/hedging';
import { pinningExpiry, histDensity, mmInventory } from '@/lib/models/market';
import { STRATEGY_CATALOG, strategyPremium, strategyPnlSurface, strategyGreeks, strategyPayoffAtExpiry } from '@/lib/models/structures';
import { delta, gamma, vega, theta } from '@/lib/models/bs';
import { fmtNum, fmtPctSigned } from '@/lib/format';

// ── the gamma scalper ──────────────────────────────────────────────────────

export function GammaScalpModel() {
  const [sigmaR, setSigmaR] = useState(0.75);
  const [sigmaI, setSigmaI] = useState(0.3);
  const [hedgeEvery, setHedgeEvery] = useState(1);
  const [seed, setSeed] = useState(12);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(28);

  // full ledger (deterministic)
  const ledger = useMemo(
    () =>
      hedgingLedger({
        seed,
        S0: 100,
        K: 100,
        days: 30,
        sigmaI,
        sigmaR,
        hedgeEvery,
        nSteps: 720,
        r: 0,
        q: 0,
        costRate: 0,
        mu: 0,
      }),
    [seed, sigmaI, sigmaR, hedgeEvery],
  );

  // the animation cursor
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setTick((x) => (x + 1) % 720), Math.max(40, 2100 - speed * 60));
    return () => clearInterval(t);
  }, [playing, speed]);

  const cursor = tick;
  const stepNow = ledger.steps[Math.min(cursor, 719)];
  // the gamma ridge (dollar gamma landscape) over (S × t)
  const { ss, tt, ridge } = useMemo(() => {
    const ss = Array.from({ length: 33 }, (_, i) => 75 + (i * 50) / 32);
    const tt = Array.from({ length: 13 }, (_, i) => 1 + i * 2);
    const ridge = ss.map((S) => tt.map((d) => 0.5 * gamma(S, 100, Math.max(d, 0.5) / 365, 0, 0, sigmaI) * S * S));
    return { ss, tt, ridge };
  }, [sigmaI]);
  // the live path lifted onto the ridge's plane
  const pathPts = ledger.steps
    .slice(0, cursor + 1)
    .filter((_, i) => i % 4 === 0)
    .map((st) => ({ x: st.S, y: st.t * 30, z: 12 }));

  const shuffle = useMemo(
    () => shuffleLedger({
      seed, S0: 100, K: 100, days: 30, sigmaI, sigmaR, hedgeEvery: 1, nSteps: 720, r: 0, q: 0, costRate: 0, mu: 0,
    }, 400),
    [seed, sigmaI, sigmaR],
  );

  return (
    <Dock viewId="models-gammascalp" layout="grid">
      <DockPanel id="live" title="The gamma scalper's ledger · live" sub="d(book) = ½ΓS²[(ΔS/S)² − σᵢ²Δt] — gamma green, theta red, net white" span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: ss, y: tt, z: ridge }, mode: 'height' }]}
            paths={[{ points: pathPts, color: '#fbbf24', width: 2, headDot: true }]}
            xLabel="spot S"
            yLabel="days"
            zLabel="dollar gamma ½ΓS²"
            height={280}
          />
          <DivergingBars
            rows={[
              { label: 'gamma', value: stepNow.gammaSum },
              { label: 'theta', value: stepNow.thetaSum },
              { label: 'net', value: stepNow.pnl },
            ]}
          />
          <Readout
            items={[
              { label: `t`, value: `${(cursor / 24).toFixed(1)}d / 30d` },
              { label: 'S', value: fmtNum(stepNow.S, 1) },
              { label: 'P&L', value: fmtNum(stepNow.pnl, 2), tone: stepNow.pnl >= 0 ? 'teal' : 'rose' },
              { label: 'breakeven daily', value: `${(ledger.breakevenDaily * 100).toFixed(2)}%` },
              { label: 'RV/IV', value: `${(sigmaR / sigmaI).toFixed(2)}×`, tone: sigmaR > sigmaI ? 'teal' : 'rose' },
            ]}
          />
          <CourseNote
            parts="Part 11 ch2–3 · Part 10 ch7"
            idea="The long-gamma hedged book farms movement: each step collects ½ΓS²(r² − σᵢ²dt). Realized 75% vs implied 30% ⇒ the gamma bar outgrows theta. The path's ORDER matters — the crash on day 19 collects little if spot already left the strike: the ridge is where the money is."
          />
        </div>
      </DockPanel>
      <DockPanel id="path" title="The month · path vs hedge vs book" span={1}>
        <LineChart
          series={[
            { label: 'spot', color: '#fbbf24', points: ledger.steps.map((st) => ({ x: st.t * 30, y: st.S })) },
            { label: 'P&L', color: '#2dd4bf', points: ledger.steps.map((st) => ({ x: st.t * 30, y: st.pnl })) },
            { label: 'gamma−theta', color: '#a78bfa', points: ledger.steps.map((st) => ({ x: st.t * 30, y: st.gammaSum + st.thetaSum })), dashed: true },
          ]}
          height={150}
          yZero
          yFormat={(v) => fmtNum(v, 0)}
          xFormat={(v) => `day ${v.toFixed(0)}`}
        />
        <ChartLegend series={[{ label: 'spot', color: '#fbbf24' }, { label: 'P&L', color: '#2dd4bf' }, { label: 'γ+Θ', color: '#a78bfa' }]} />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => setPlaying((p) => !p)}
            className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[9px] uppercase tracking-wider text-zinc-400 transition hover:border-teal-700/60 hover:text-teal-300"
          >
            {playing ? 'pause' : 'play'}
          </button>
          <ParamSlider label="speed" value={speed} min={1} max={34} step={1} onChange={setSpeed} />
        </div>
      </DockPanel>
      <DockPanel id="shuffle" title="Same returns, reshuffled · the path-order counterfactual" sub="identical realized variance — wildly different P&L" span={1}>
        <LineChart
          series={[
            { label: 'reshuffles', color: '#71717a', points: shuffle.samples.map((v, i) => ({ x: i, y: v })) },
            { label: 'real month', color: '#fbbf24', points: [{ x: 0, y: shuffle.base.total }, { x: shuffle.samples.length - 1, y: shuffle.base.total }] },
          ]}
          height={130}
          yZero
          yFormat={(v) => fmtNum(v, 1)}
          xFormat={(v) => `perm ${v.toFixed(0)}`}
        />
        <ChartLegend series={[{ label: '400 permutations', color: '#71717a' }, { label: 'the real month', color: '#fbbf24' }]} />
        <Readout
          items={[
            { label: 'mean', value: fmtNum(shuffle.mean, 2) },
            { label: '5–95%', value: `${fmtNum(shuffle.p05, 1)} … ${fmtNum(shuffle.p95, 1)}` },
            { label: 'real month', value: fmtNum(shuffle.base.total, 2), tone: 'amber' },
          ]}
        />
        <CourseNote parts="Part 11 ch2 · El Karoui–Jeanblanc–Shreve 1998" idea="E[P&L | path] ≠ f(Σr²): the weight ΓS² depends on WHERE spot is when the move happens — the variance swap (weighting by 1/S²) is the fix that collects Σr² exactly." />
      </DockPanel>
      <DockPanel id="controls" title="The desk's knobs" span={1}>
        <div className="space-y-3">
          <ParamSlider label="realized vol (the path)" value={sigmaR} min={0.05} max={1.5} step={0.05} onChange={setSigmaR} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="implied vol (the mark)" value={sigmaI} min={0.05} max={1.5} step={0.05} onChange={setSigmaI} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <div>
            <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-400">hedge frequency</span>
            <div className="mt-1">
              <Segmented
                value={hedgeEvery === 1 ? 'hourly' : hedgeEvery === 24 ? 'daily' : 'move'}
                onChange={(v) => setHedgeEvery(v === 'hourly' ? 1 : v === 'daily' ? 24 : -1)}
                options={[
                  { id: 'hourly', label: 'hourly' },
                  { id: 'daily', label: 'daily' },
                  { id: 'move', label: 'on ±2%' },
                ]}
              />
            </div>
          </div>
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'hedge trades', value: ledger.trades },
              { label: 'total P&L', value: fmtNum(ledger.total, 2), tone: ledger.total >= 0 ? 'teal' : 'rose' },
              { label: 'residual vs ledger', value: fmtNum(ledger.residual, 3), sub: 'total − (gamma + theta): the discretisation dust' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the P&L explain waterfall ───────────────────────────────────────────────

export function PnlExplainModel() {
  const [dS, setDS] = useState(-2.4);
  const [dVol, setDVol] = useState(-2.6);
  const [sigma0, setSigma0] = useState(0.45);

  const report = useMemo(
    () =>
      pnlExplain(
        [
          { call: true, K: 100, days: 30, qty: 1 },
          { call: false, K: 90, days: 30, qty: -2 },
          { call: true, K: 110, days: 30, qty: 1 },
        ],
        100,
        sigma0,
        dS,
        dVol * 0.01,
        1,
        0.05,
        0,
      ),
    [dS, dVol, sigma0],
  );

  return (
    <Dock viewId="models-pnlexplain" layout="grid">
      <DockPanel id="waterfall" title="The P&L explain · one night on the desk" sub="spot −2.4%, vol −2.6 pts, one day — the waterfall vs the real revaluation" span={2}>
        <div className="space-y-2">
          <DivergingBars
            rows={[
              ...report.contributions.map((c) => ({ label: c.label, value: c.value })),
              { label: 'unexplained', value: report.unexplained },
              { label: 'TOTAL', value: report.total },
            ]}
          />
          <Readout
            items={[
              { label: 'actual P&L', value: fmtNum(report.total, 1), tone: report.total >= 0 ? 'teal' : 'rose' },
              { label: 'unexplained', value: `${fmtNum(report.unexplained, 2)} (${fmtNum((report.unexplained / (report.total || 1)) * 100, 1)}%)`, tone: 'amber' },
              { label: 'the surprise', value: 'vanna — spot and vol fell together' },
            ]}
          />
          <CourseNote
            parts="Part 11 ch1"
            idea="The desk's morning report is one Taylor series: ΔdS + ½ΓdS² + Θdt + 𝒱dσ + vanna·dSdσ + ½volga·dσ². The course's own probe: −1,521 actual, −1,548 explained, +28 unexplained (1.8%) — here the same book, live."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Overnight scenario" span={1}>
        <div className="space-y-3">
          <ParamSlider label="spot move" value={dS} min={-8} max={8} step={0.2} onChange={setDS} format={(v) => fmtPctSigned(v, 1)} />
          <ParamSlider label="vol move (points)" value={dVol} min={-10} max={10} step={0.2} onChange={setDVol} format={(v) => `${v.toFixed(1)} pts`} />
          <ParamSlider label="entry vol σ₀" value={sigma0} min={0.2} max={1} step={0.05} onChange={setSigma0} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <Panel title="the book">
            <div className="space-y-0.5 font-mono text-[9px] text-zinc-400">
              <div>+1 · 30d ATM call (100)</div>
              <div>−2 · 30d 90% puts</div>
              <div>+1 · 30d 110% call</div>
            </div>
          </Panel>
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the no-trade corridor (Whalley–Wilmott) ─────────────────────────────────

export function WwBandModel() {
  const [costRate, setCostRate] = useState(0.001);
  const [riskAversion, setRiskAversion] = useState(1);
  const [sigma, setSigma] = useState(0.4);

  const bands = useMemo(() => {
    const days = [21, 14, 10, 7, 5, 3, 2, 1];
    return days.map((d) => ({ d, band: wwBand(100, 100, d / 365, sigma, 0.05, 0, costRate, riskAversion) }));
  }, [costRate, riskAversion, sigma]);

  const bandBy2x = wwBand(100, 100, 0.25, sigma, 0.05, 0, costRate * 2, riskAversion).halfWidth /
    wwBand(100, 100, 0.25, sigma, 0.05, 0, costRate, riskAversion).halfWidth;

  const series = [
    { label: 'no-trade corridor (±Δ)', color: '#2dd4bf', points: bands.map((b) => ({ x: b.d, y: b.band.halfWidth })) },
  ];

  return (
    <Dock viewId="models-wwband" layout="grid">
      <DockPanel id="band" title="The no-trade corridor · Whalley–Wilmott" sub="hedge only when delta leaves the band — the band's width is the CUBE ROOT of cost" span={2}>
        <div className="space-y-2">
          <LineChart
            series={series}
            height={170}
            yZero
            yFormat={(v) => fmtNum(v, 3)}
            xFormat={(v) => `${v.toFixed(0)}d`}
          />
          <ChartLegend series={[{ label: 'band half-width (delta units)', color: '#2dd4bf' }]} />
          <Readout
            items={[
              { label: '×2 cost ⇒ band', value: `×${fmtNum(bandBy2x, 2)} (= 2^{1/3} ≈ 1.26)`, tone: 'teal' },
              { label: '30d band', value: `±${fmtNum(bands[0].band.halfWidth, 4)} delta` },
              { label: '1d band', value: `±${fmtNum(bands[7].band.halfWidth, 4)} delta` },
              { label: 'deep-hedging note', value: 'Part 17: the learned band ≈ 0.7× WW at the money' },
            ]}
          />
          <CourseNote
            parts="Part 11 ch8 · Part 17 ch13–14 · Whalley–Wilmott 1997 · Leland 1985"
            idea="With transaction costs, continuous hedging is ruin: the optimal policy is a dead zone around delta. The band widens as expiry approaches? No — the dollar gamma explodes, so it narrows in delta units but the cost of leaving it grows. Costs make frequency a TRADE: Leland's adjusted vol is the empirical answer (measured in the tests, not quoted)."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Cost & risk aversion" span={1}>
        <div className="space-y-3">
          <ParamSlider label="proportional cost" value={costRate} min={0} max={0.005} step={0.00025} onChange={setCostRate} format={(v) => `${(v * 10000).toFixed(0)} bps`} />
          <ParamSlider label="risk aversion λ" value={riskAversion} min={0.2} max={8} step={0.2} onChange={setRiskAversion} />
          <ParamSlider label="volatility σ" value={sigma} min={0.1} max={1} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'WW half-width', value: '∝ (κΓ$) ^{1/3}', sub: 'cube root of cost × dollar gamma over risk aversion' },
              { label: 'Leland 1985', value: 'σ_L = σ√(1+Le)', sub: 'costs act like a HIGHER vol — the discrete hedger marks at σ_L' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── pinning at expiry ──────────────────────────────────────────────────────

export function PinningModel() {
  const [kappa, setKappa] = useState(8);
  const [sigma, setSigma] = useState(0.5);
  const [seed, setSeed] = useState(9);

  const { withPin, withoutPin, histP, histQ } = useMemo(() => {
    const { withPin, withoutPin } = pinningExpiry(seed, { S0: 100, K: 100, T: 30 / 365, sigma, steps: 240, nPaths: 800, kappa });
    return {
      withPin,
      withoutPin,
      histP: histDensity(withPin, 90, 112, 44),
      histQ: histDensity(withoutPin, 90, 112, 44),
    };
  }, [kappa, sigma, seed]);

  const sd = (xs: number[]) => {
    const m = xs.reduce((s, v) => s + v, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / xs.length);
  };
  const nearStrikeP = withPin.filter((s) => Math.abs(s - 100) < 1.5).length / withPin.length;
  const nearStrikeQ = withoutPin.filter((s) => Math.abs(s - 100) < 1.5).length / withoutPin.length;

  return (
    <Dock viewId="models-pinning" layout="grid">
      <DockPanel id="dist" title="Expiry pinning · dealer gamma pulls spot to the strike" sub="S_T distribution with vs without the hedging force — 800 paths each" span={2}>
        <div className="space-y-2">
          <LineChart
            series={[
              { label: 'with dealer gamma (κ>0)', color: '#2dd4bf', points: histP.x.map((x, i) => ({ x, y: histP.y[i] })) },
              { label: 'no pin force', color: '#71717a', points: histQ.x.map((x, i) => ({ x, y: histQ.y[i] })), dashed: true },
            ]}
            height={180}
            yFormat={(v) => fmtNum(v, 2)}
            xFormat={(v) => fmtNum(v, 0)}
          />
          <ChartLegend series={[{ label: 'pinned', color: '#2dd4bf' }, { label: 'free', color: '#71717a' }]} />
          <Readout
            items={[
              { label: 'P(|S_T − K| < 1.5)', value: `${(nearStrikeP * 100).toFixed(1)}% vs ${(nearStrikeQ * 100).toFixed(1)}%`, tone: 'teal' },
              { label: 'sd(S_T)', value: `${fmtNum(sd(withPin), 2)} vs ${fmtNum(sd(withoutPin), 2)}` },
              { label: 'ATM gamma', value: '0.15 → 5.8 from a day to a minute' },
            ]}
          />
          <CourseNote
            parts="Part 11 ch11 · Avellaneda–Lipkin 2003 · Ni–Pearson–Poteshman 2005"
            idea="Dealers short gamma hedge by buying when spot falls, selling when it rises — near expiry, at a big strike, that force pins the underlying to K. The 0DTE era makes this force daily; volmageddon (Feb 2018) was the same feedback running backwards."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Pin force" span={1}>
        <div className="space-y-3">
          <ParamSlider label="pin strength κ" value={kappa} min={0} max={20} step={1} onChange={setKappa} hint="the dealer's delta-hedging pull toward K" />
          <ParamSlider label="volatility σ" value={sigma} min={0.1} max={1.2} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'κ = 0', value: 'no pin', sub: 'the free distribution — pure GBM' },
              { label: 'κ large', value: 'a magnet', sub: 'S_T collapses onto the strike — pin risk for short options' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── the market maker's book ─────────────────────────────────────────────────

export function MmInventoryModel() {
  const [skew, setSkew] = useState(0.3);
  const [adverse, setAdverse] = useState(0.3);
  const [seed, setSeed] = useState(5);

  const noSkew = useMemo(
    () => mmInventory(seed, { S0: 100, steps: 2000, sigma: 0.5, halfSpread: 0.05, skew: 0, adverse, fillProb: 0.25 }),
    [seed, adverse],
  );
  const withSkew = useMemo(
    () => mmInventory(seed, { S0: 100, steps: 2000, sigma: 0.5, halfSpread: 0.05, skew, adverse, fillProb: 0.25 }),
    [seed, adverse, skew],
  );

  return (
    <Dock viewId="models-mminventory" layout="grid">
      <DockPanel id="compare" title="The market maker's book · inventory skew on/off" sub="same market, same seed — the skew is the only difference" span={2}>
        <div className="space-y-2">
          <LineChart
            series={[
              { label: 'inventory (no skew)', color: '#71717a', points: noSkew.inventory.map((v, i) => ({ x: i, y: v })) },
              { label: 'inventory (with skew)', color: '#2dd4bf', points: withSkew.inventory.map((v, i) => ({ x: i, y: v })) },
            ]}
            height={150}
            yZero
            yFormat={(v) => fmtNum(v, 0)}
            xFormat={(v) => `t${v.toFixed(0)}`}
          />
          <ChartLegend series={[{ label: 'no skew', color: '#71717a' }, { label: 'skewed quotes', color: '#2dd4bf' }]} />
          <Readout
            items={[
              { label: 'max |inventory|', value: `${noSkew.maxInventory} → ${withSkew.maxInventory}`, tone: 'teal' },
              { label: 'P&L', value: `${fmtNum(noSkew.endingPnl, 2)} → ${fmtNum(withSkew.endingPnl, 2)}` },
              { label: 'adverse-selection cost', value: `${fmtNum(noSkew.adverseCost, 2)} → ${fmtNum(withSkew.adverseCost, 2)}` },
              { label: 'the lecture pair', value: '64 → 9 max inventory' },
            ]}
          />
          <CourseNote
            parts="Part 11 ch9 · Glosten–Milgrom 1985 · Avellaneda–Stoikov 2008 · Gârleanu–Pedersen–Poteshman 2009"
            idea="Quotes exist to trade WITH the flow at a price that survives being wrong: spread pays for adverse selection (your bid fills when the market is about down); inventory skew leans quotes away from a full book. Options MM in vol units: the 'why' of demand-pressure skew."
          />
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Quoting parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="inventory skew κ" value={skew} min={0} max={0.6} step={0.05} onChange={setSkew} />
          <ParamSlider label="adverse selection" value={adverse} min={0} max={0.8} step={0.05} onChange={setAdverse} />
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'half-spread', value: '0.05', sub: 'the rent for quoting' },
              { label: 'quote skew', value: '−inv·κ', sub: 'long book ⇒ quotes down ⇒ sells come to you' },
            ]}
          />
        </div>
      </DockPanel>
    </Dock>
  );
}

// ── strategy shapes: the P&L surface morphs ────────────────────────────────

const SPOT_MOVES = Array.from({ length: 25 }, (_, i) => -0.24 + (i * 0.48) / 24);
const VOL_MOVES = Array.from({ length: 17 }, (_, i) => -12 + i * 1.5);

export function StrategyShapesModel() {
  const [strategyId, setStrategyId] = useState('longStraddle');
  const [sigma0, setSigma0] = useState(0.45);
  const [horizonDays, setHorizonDays] = useState(7);

  const def = useMemo(() => STRATEGY_CATALOG.find((s) => s.id === strategyId)!, [strategyId]);
  const surface = useMemo(
    () => strategyPnlSurface(def, 100, sigma0, 0.05, 0, SPOT_MOVES, VOL_MOVES, horizonDays),
    [def, sigma0, horizonDays],
  );
  const premium = strategyPremium(def, 100, sigma0, 0.05, 0);
  const greeks = strategyGreeks(def, 100, sigma0, 0.05, 0, { delta, gamma, vega, theta });
  const payoff = useMemo(
    () => strategyPayoffAtExpiry(def, 100, SPOT_MOVES.filter((_, i) => i % 2 === 0), 0.05, 0),
    [def],
  );
  const payoffPts = SPOT_MOVES.filter((_, i) => i % 2 === 0)
    .map((x, j) => ({ x: 100 * (1 + x), y: 0.01, z: payoff[j] - premium }));

  return (
    <Dock viewId="models-strategies" layout="grid">
      <DockPanel id="surface" title={`${def.name} · the P&L surface over (spot, vol)`} sub={`after ${horizonDays}d — the expiration diagram is the surface's last slice (amber line)`} span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: SPOT_MOVES.map((x) => 100 * (1 + x)), y: VOL_MOVES, z: surface }, mode: 'height' }]}
            paths={[{ points: payoffPts, color: '#fbbf24', width: 1.8 }]}
            planes={[{ axis: 'y', at: 0, color: 'rgba(45,212,191,1)', alpha: 0.04 }]}
            xLabel="spot"
            yLabel="vol move (points)"
            zLabel="P&L"
            height={310}
          />
          <Readout
            items={[
              { label: 'entry premium', value: fmtNum(premium, 2), tone: premium < 0 ? 'amber' : 'zinc' },
              { label: 'Δ', value: fmtNum(greeks.delta, 3) },
              { label: 'Γ', value: fmtNum(greeks.gamma, 4) },
              { label: '𝒱 (per pt)', value: fmtNum(greeks.vega * 0.01, 2) },
              { label: 'Θ/day', value: fmtNum(greeks.thetaDay, 2) },
              { label: 'bets', value: `γ ${def.bets.gamma} · 𝒱 ${def.bets.vega} · skew: ${def.bets.skew}` },
            ]}
          />
          <CourseNote parts="Part 11 ch5 · Natenberg ch 10–15" idea={def.idea} />
        </div>
      </DockPanel>
      <DockPanel id="catalog" title="The structure catalog" span={1}>
        <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
          {STRATEGY_CATALOG.map((s) => (
            <button
              key={s.id}
              onClick={() => setStrategyId(s.id)}
              className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left transition ${
                strategyId === s.id ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              <span className="text-[10px] font-medium">{s.name}</span>
              <span className="font-mono text-[8px] text-zinc-600">{s.family}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 space-y-3">
          <ParamSlider label="entry vol σ₀" value={sigma0} min={0.15} max={1} step={0.05} onChange={setSigma0} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="holding period (days)" value={horizonDays} min={0} max={30} step={1} onChange={setHorizonDays} format={(v) => `${v.toFixed(0)}d`} hint="0 = entry; 30 = expiry (the surface's last slice)" />
        </div>
      </DockPanel>
    </Dock>
  );
}
