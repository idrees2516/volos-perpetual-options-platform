'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · panels-exotics — the zoo (Part 17 + Gatheral ch 9–10 +
// Taleb Part III): EVERY kind of option in one place, each with its exact
// payoff machinery, priced by seeded antithetic Monte Carlo (vanilla
// baseline included), with the path cloud showing WHY its price is what it
// is — the barrier plane, the averaging, the extremes. Choose an exotic,
// watch its paths, read its bets.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { Surface3d } from './surface3d';
import { ParamSlider, CourseNote, Readout, RerollButton } from './models-ui';
import { StatGrid, Segmented, LineChart, ChartLegend } from '@/components/terminal/quantlab/quant-viz';
import { priceExotic, EXOTIC_SPECS, exoticDelta, vanillaDelta } from '@/lib/models/exotics';
import { gbmFan, mcOneTouch } from '@/lib/models/processes';
import { fmtNum } from '@/lib/format';

export function ExoticsZooModel() {
  const [exoticId, setExoticId] = useState('downOut');
  const [sigma, setSigma] = useState(0.4);
  const [barrier, setBarrier] = useState(0.85);
  const [T, setT] = useState(0.5);
  const [seed, setSeed] = useState(7);

  const params = useMemo(
    () => ({
      S0: 100,
      K: 100,
      T,
      r: 0.05,
      q: 0,
      sigma,
      barrier: 100 * barrier,
      payout: 10,
      cap: 0.1,
      coupon: 0.08,
      nPaths: 8000,
      seed,
      sigma2: 0.3,
      corr: 0.5,
    }),
    [T, sigma, barrier, seed],
  );

  const quote = useMemo(() => priceExotic(exoticId, params), [exoticId, params]);
  const spec = EXOTIC_SPECS.find((s) => s.id === exoticId)!;
  /** closed-form quotes (perpetual, exchange) carry `closed`; one-touch carries both */
  const hasClosed = quote != null && 'closed' in quote;
  const price = quote && 'price' in quote ? quote.price : (quote as { closed: number } | null)?.closed ?? NaN;
  const stderr = quote && 'stderr' in quote ? quote.stderr : undefined;
  const vanilla = quote && 'vanilla' in quote ? quote.vanilla : NaN;
  const note = quote && 'note' in quote ? (quote as { note: string }).note : undefined;

  // seeded path cloud for the visual (12 paths) — Array.from, not .map (TypedArray!)
  const paths = useMemo(() => {
    const fan = gbmFan(seed, 12, 100, T, 60, 0.05, sigma);
    return fan.map((p) => Array.from(p, (S, i) => ({ x: (i / 60) * T, y: (i % 9) / 9, z: S })));
  }, [seed, sigma, T]);

  // barrier plane levels (log→price domain)
  const bLow = params.barrier;
  const isDown = exoticId.toLowerCase().includes('down') || exoticId === 'autocall';

  // delta comparison (bump & re-price) vs vanilla
  const exDelta = useMemo(() => exoticDelta(exoticId, params), [exoticId, params]);
  const vanDelta = vanillaDelta(true, 100, 100, T, 0.05, 0, sigma);

  // one-touch closed/MC comparison where relevant
  const touch = useMemo(() => {
    if (exoticId !== 'oneTouch') return null;
    const B = Math.max(params.barrier, 100 * 1.01);
    return mcOneTouch(100, B, T, 0.05, 0, sigma, 30000, seed);
  }, [exoticId, params, T, sigma, seed]);

  const families = useMemo(() => {
    const groups: { family: string; ids: string[] }[] = [
      { family: 'vanilla & asian', ids: ['vanilla', 'asianA', 'asianG', 'asianFloat'] },
      { family: 'barriers', ids: ['downOut', 'downIn', 'upOut', 'oneTouch'] },
      { family: 'binaries', ids: ['binaryCash', 'binaryAsset'] },
      { family: 'lookbacks', ids: ['lookbackFloat', 'lookbackFixed'] },
      { family: 'forward & chooser', ids: ['chooser', 'forwardStart'] },
      { family: 'structured', ids: ['cliquet', 'autocall', 'perpetual', 'exchange'] },
    ];
    return groups;
  }, []);

  return (
    <Dock viewId="models-exotics" layout="grid">
      <DockPanel id="paths" title={`${spec.name} · the path machinery`} sub={`${spec.idea}`} span={2}>
        <div className="space-y-2">
          <Surface3d
            surfaces={[{ data: { x: [0, T], y: [0, 1], z: [[0, 0], [0, 0]] } }]}
            paths={paths.map((pts, i) => ({
              points: pts,
              color: i === 0 ? 'rgba(45,212,191,0.95)' : `rgba(113,113,122,${0.3 + 0.4 * (i / 12)})`,
              width: i === 0 ? 2 : 1,
            }))}
            planes={isDown ? [{ axis: 'y', at: 0.5, color: 'rgba(251,113,133,1)', alpha: 0.07 }] : []}
            xLabel="t (years)"
            yLabel="path #"
            zLabel="S"
            height={300}
          />
          <Readout
            items={[
              { label: 'price', value: Number.isFinite(price) ? fmtNum(price, 3) : '—', tone: 'teal' },
              ...(stderr !== undefined ? [{ label: '± stderr', value: fmtNum(stderr, 3) }] : []),
              ...(Number.isFinite(vanilla) ? [{ label: 'vanilla baseline', value: fmtNum(vanilla, 3) }] : []),
              ...(Number.isFinite(price) && Number.isFinite(vanilla)
                ? [{ label: 'exotic / vanilla', value: `${fmtNum(price / (vanilla || 1), 2)}×`, tone: (price < vanilla ? 'rose' : 'teal') as 'rose' | 'teal' }]
                : []),
              ...(note ? [{ label: 'closed form', value: note }] : []),
            ]}
          />
          <CourseNote
            parts="Part 17 · Gatheral ch 9–10 · Taleb Part III"
            idea={`${spec.bets}. Barrier monitoring matters (Broadie–Glasserman–Kou's continuity correction β≈0.5826σ√dt — the lab's one-touch carries an exact Brownian-bridge MC to show it).`}
          />
        </div>
      </DockPanel>
      <DockPanel id="catalog" title="The zoo · every kind of option" span={1}>
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {families.map((fam) => (
            <div key={fam.family}>
              <p className="px-1 pb-0.5 text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-600">{fam.family}</p>
              {fam.ids.map((id) => {
                const s = EXOTIC_SPECS.find((x) => x.id === id)!;
                return (
                  <button
                    key={id}
                    onClick={() => setExoticId(id)}
                    className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left transition ${
                      exoticId === id ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                  >
                    <span className="text-[10px] font-medium leading-tight">{s.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </DockPanel>
      <DockPanel id="controls" title="Contract parameters" span={1}>
        <div className="space-y-3">
          <ParamSlider label="volatility σ" value={sigma} min={0.1} max={1.2} step={0.05} onChange={setSigma} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <ParamSlider label="maturity T" value={T} min={0.08} max={2} step={0.08} onChange={setT} format={(v) => `${v.toFixed(2)}y`} />
          <ParamSlider label="barrier (× spot)" value={barrier} min={0.6} max={1.4} step={0.05} onChange={setBarrier} format={(v) => `${v.toFixed(2)}×`} hint="KO dies on the touch; KI is born on it" />
          <RerollButton seed={seed} onSeed={() => setSeed(Math.floor(Math.random() * 9999))} />
          <StatGrid
            cols={2}
            stats={[
              { label: 'exotic Δ (bump)', value: exDelta != null ? fmtNum(exDelta, 3) : '—', sub: 're-priced at S±1% — the discontinuity\'s hedge' },
              { label: 'vanilla Δ', value: fmtNum(vanDelta, 3), sub: 'the same option without the exotic feature' },
            ]}
          />
          {touch && (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-600">one-touch monitoring check</p>
              <p className="mt-1 font-mono text-[9px] text-zinc-300">
                Brownian-bridge MC {fmtNum(touch.price, 3)} ± {fmtNum(touch.stderr, 3)}
              </p>
            </div>
          )}
        </div>
      </DockPanel>
      {hasClosed ? (
        <DockPanel id="closed" title="Closed form vs MC" span={2}>
          <LineChart
            series={[
              {
                label: 'closed form',
                color: '#a78bfa',
                points: Array.from({ length: 40 }, (_, i) => ({ x: 0.5 + i * 0.05, y: (priceExotic(exoticId, { ...params, T: 0.5 + i * 0.05 }) as { closed: number }).closed })),
              },
            ]}
            height={140}
            yFormat={(v) => fmtNum(v, 2)}
            xFormat={(v) => `${v.toFixed(2)}y`}
          />
          <ChartLegend series={[{ label: 'closed form (Merton / Margrabe / reflection)', color: '#a78bfa' }]} />
        </DockPanel>
      ) : null}
    </Dock>
  );
}
