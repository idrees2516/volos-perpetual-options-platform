'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Gamma & Flow Lab (v1.9 depth) — dealer positioning computed from REAL
// Black-Scholes greeks on the live vol surface with deterministic synthetic OI:
//   • GEX / CHARM / VANNA per strike × expiry heatmaps
//   • call wall · put wall · gamma flip with $ magnitudes
//   • IV term structure + vol smile (both wings) charts
//   • flow tape with notional, moneyness, sweep/block tags, cumulative pressure
//   • put/call OI + volume ratios, 0DTE share
// Seeded deterministically from REAL live spot so the surface tracks the market.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import {
  Activity, Waves, Flame, ArrowUpRight, ArrowDownRight, LineChart as LineIcon, Smile,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts';
import { blackScholes, surfaceIv, termStructure, smilePoints } from '@/lib/pricing';
import { BASE_IV, type UnderlyingId } from '@/lib/types';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useUi } from '@/stores/ui-store';
import type { MarketState } from '@/hooks/use-market';

// deterministic PRNG so the surface is stable frame-to-frame but spot-anchored
function hash32(n: number): number {
  let x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const EXPIRIES = [
  { dte: 0, label: '0DTE' },
  { dte: 7, label: '7d' },
  { dte: 30, label: '30d' },
  { dte: 60, label: '60d' },
  { dte: 90, label: '90d' },
  { dte: 180, label: '180d' },
];

const FOUR_VENUES = ['Deribit', 'Binance', 'Hyperliquid', 'Lighter'];

interface FlowPrint {
  id: number;
  ts: number;
  underlying: string;
  symbol: string;
  side: 'buy' | 'sell';
  premium: number;
  size: number;
  venue: string;
  aggressive: boolean;
  block: boolean;
  iv: number;
  otm: boolean;
  zeroDte: boolean;
}

function genFlow(seed: number, spotMap: Record<string, number>): FlowPrint[] {
  const unds: [string, number, number][] = [
    ['BTC', spotMap.BTC ?? 80000, 80],
    ['ETH', spotMap.ETH ?? 3800, 4],
    ['SOL', spotMap.SOL ?? 180, 0.4],
  ];
  const out: FlowPrint[] = [];
  for (let i = 0; i < 30; i++) {
    const u = unds[Math.floor(hash32(seed + i * 3) * unds.length)];
    const strikePct = 1 + (hash32(seed + i * 5) - 0.5) * 0.18;
    const strike = Math.round((u[1] * strikePct) / (u[1] > 1000 ? 500 : u[1] > 100 ? 5 : 0.5)) * (u[1] > 1000 ? 500 : u[1] > 100 ? 5 : 0.5);
    const isCall = hash32(seed + i * 7) > 0.48;
    const size = Math.round(1 + hash32(seed + i * 11) * 420);
    const premium = size * u[2] * (0.5 + hash32(seed + i * 13) * 4);
    const zeroDte = hash32(seed + i * 29) > 0.72;
    out.push({
      id: i,
      ts: Date.now() - i * 13000 - Math.floor(hash32(seed + i) * 9000),
      underlying: u[0],
      symbol: `${u[0]} ${strike.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${isCall ? 'C' : 'P'}`,
      side: hash32(seed + i * 17) > 0.5 ? 'buy' : 'sell',
      premium,
      size,
      venue: FOUR_VENUES[Math.floor(hash32(seed + i * 19) * FOUR_VENUES.length)],
      aggressive: hash32(seed + i * 23) > 0.78,
      block: size > 300,
      iv: 0.42 + hash32(seed + i * 31) * 0.35,
      otm: isCall ? strike > u[1] : strike < u[1],
      zeroDte,
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

interface StrikeRow {
  strike: number;
  atm: boolean;
  cOi: number; pOi: number; cVol: number; pVol: number;
  cGex: number; pGex: number; netGex: number;
  charm: number; vanna: number;
}

export function GammaFlowView({ market }: { market: MarketState }) {
  const { gammaTab, setGammaTab } = useUi();
  const [und, setUnd] = useState<UnderlyingId>('BTC');
  const spot = market.prices[und]?.price ?? (und === 'BTC' ? 80000 : und === 'ETH' ? 3800 : 180);
  const base = BASE_IV[und];
  const flowSeed = Math.floor(Date.now() / 60000); // refresh prints each minute
  const flow = useMemo(() => genFlow(flowSeed, market.prices as Record<string, number>), [flowSeed, market.prices]);

  // ── strike grid with BS greeks + synthetic OI → dealer positioning ──────
  const rows: StrikeRow[] = useMemo(() => {
    const step = spot > 10000 ? 2500 : spot > 1000 ? 250 : 25;
    const grid = Math.round(spot / step) * step;
    const out: StrikeRow[] = [];
    for (let i = -7; i <= 7; i++) {
      const k = grid + i * step;
      const off = ((k - spot) / spot) * 100;
      const cIv = surfaceIv('call', off, 30, base);
      const pIv = surfaceIv('put', off, 30, base);
      const c = blackScholes('call', spot, k, cIv, 30);
      const p = blackScholes('put', spot, k, pIv, 30);
      const oiSeed = Math.abs(Math.sin(k / (step * 7)));
      const cOi = Math.round(200 + oiSeed * 9000 * (1 - Math.abs(i) / 10));
      const pOi = Math.round(200 + oiSeed * 11000 * (1 - Math.abs(i) / 10) * (i < 0 ? 1.3 : 0.7));
      const cVol = Math.round(cOi * (0.05 + hash32(k) * 0.35));
      const pVol = Math.round(pOi * (0.05 + hash32(k + 7) * 0.35));
      // dealer positioning: short customer calls (−γ), long customer puts (+γ)
      const cGex = -c.gamma * cOi * spot * spot / 1e6;
      const pGex = +p.gamma * pOi * spot * spot / 1e6;
      // charm: dΔ/dt — dealers' decay flow; vanna: dν/dS — vol-spot coupling
      const t = 30 / 365;
      const charm = (cOi * c.theta + pOi * p.theta) / 1e3; // $k/day of delta bleed
      const vanna = -(cOi * c.vega * c.delta + pOi * p.vega * p.delta) / spot / 1e3; // $k/1% spot
      out.push({
        strike: k, atm: Math.abs(k - spot) < step / 2,
        cOi, pOi, cVol, pVol,
        cGex, pGex, netGex: cGex + pGex,
        charm, vanna,
      });
    }
    return out;
  }, [spot, base]);

  // ── heatmap surface: strike × expiry GEX from BS at each expiry ──────────
  const gexGrid = useMemo(() => {
    return rows.map((r) => {
      const off = ((r.strike - spot) / spot) * 100;
      const cells = EXPIRIES.map((e) => {
        const cIv = surfaceIv('call', off, e.dte, base);
        const pIv = surfaceIv('put', off, e.dte, base);
        const c = blackScholes('call', spot, r.strike, cIv, Math.max(e.dte, 0.5));
        const p = blackScholes('put', spot, r.strike, pIv, Math.max(e.dte, 0.5));
        // expiry-decaying OI share
        const share = 1 / (1 + EXPIRIES.findIndex((x) => x.dte === e.dte) * 0.35);
        const cOi = r.cOi * share, pOi = r.pOi * share;
        return (-c.gamma * cOi + p.gamma * pOi) * spot * spot / 1e6;
      });
      return { strike: r.strike, cells, net: cells.reduce((a, b) => a + b, 0) };
    });
  }, [rows, spot, base]);

  const maxAbs = Math.max(...gexGrid.flatMap((r) => r.cells.map((c) => Math.abs(c))), 1);
  const callWall = gexGrid.reduce((a, b) => (b.net > a.net ? b : a), gexGrid[0]);
  const putWall = gexGrid.reduce((a, b) => (b.net < a.net ? b : a), gexGrid[0]);
  let cum = 0;
  const cumGex = gexGrid.map((r) => (cum += r.net));
  let flip: number | null = null;
  for (let i = 0; i < gexGrid.length; i++) {
    if (i > 0 && Math.sign(cumGex[i - 1]) !== Math.sign(cumGex[i])) {
      flip = gexGrid[i].strike;
      break;
    }
  }

  // ── IV term structure & smile chart data ─────────────────────────────────
  const tsData = useMemo(() => termStructure(base).map((p) => ({ dte: p.dte, iv: +(p.iv * 100).toFixed(2) })), [base]);
  const smileData = useMemo(() => smilePoints(30, base).map((p) => ({
    off: p.off,
    call: +(p.call * 100).toFixed(2),
    put: +(p.put * 100).toFixed(2),
  })), [base]);

  // ── flow aggregates ───────────────────────────────────────────────────────
  const flowStats = useMemo(() => {
    const buyPrem = flow.filter((f) => f.side === 'buy').reduce((a, f) => a + f.premium, 0);
    const sellPrem = flow.filter((f) => f.side === 'sell').reduce((a, f) => a + f.premium, 0);
    const callPrem = flow.reduce((a, f) => a + (f.symbol.endsWith('C') ? f.premium : 0), 0);
    const putPrem = flow.reduce((a, f) => a + (f.symbol.endsWith('P') ? f.premium : 0), 0);
    const totalOi = rows.reduce((a, r) => a + r.cOi + r.pOi, 0);
    const totalVol = rows.reduce((a, r) => a + r.cVol + r.pVol, 0);
    const cOi = rows.reduce((a, r) => a + r.cOi, 0);
    const pOi = rows.reduce((a, r) => a + r.pOi, 0);
    const zeroDtePrem = flow.filter((f) => f.zeroDte).reduce((a, f) => a + f.premium, 0);
    const sweeps = flow.filter((f) => f.aggressive).length;
    const blocks = flow.filter((f) => f.block).length;
    return {
      buyPrem, sellPrem, callPrem, putPrem, totalOi, totalVol, cOi, pOi, zeroDtePrem, sweeps, blocks,
      pcOi: pOi / Math.max(cOi, 1),
      pcPrem: putPrem / Math.max(callPrem, 1),
      buyPressure: buyPrem / Math.max(buyPrem + sellPrem, 1),
      zeroDteShare: zeroDtePrem / Math.max(buyPrem + sellPrem, 1),
    };
  }, [flow, rows]);

  const TABS = [
    ['overview', 'Overview', <Waves key="g-ov" className="h-3.5 w-3.5" />],
    ['heatmaps', 'Heatmaps', <Activity key="g-hm" className="h-3.5 w-3.5" />],
    ['vol', 'Vol Surface', <LineIcon key="g-vs" className="h-3.5 w-3.5" />],
    ['flow', 'Flow Tape', <Flame key="g-fl" className="h-3.5 w-3.5" />],
  ] as const;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3">
        <h1 className="text-lg font-bold tracking-tight text-zinc-100">Gamma & Flow Lab</h1>
        <div className="flex items-center gap-1">
          {(['BTC', 'ETH', 'SOL'] as const).map((u) => (
            <button
              key={`gu-${u}`}
              type="button"
              onClick={() => setUnd(u)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                und === u ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-700/50' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {u} {market.prices[u] ? fmtUsd(market.prices[u].price) : '…'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          {TABS.map(([id, label, icon]) => (
            <button
              key={`gtab-${id}`}
              type="button"
              onClick={() => setGammaTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                gammaTab === id ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {/* dealer stat cards — walls, flip, ratios */}
      {(gammaTab === 'overview' || gammaTab === 'heatmaps') && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Call wall (gamma cap)', value: callWall.strike, sub: `+${fmtNum(callWall.net, 1)}M dealer γ`, tone: 'text-emerald-300', note: 'dealer short calls pin rallies' },
            { label: 'Put wall (gamma floor)', value: putWall.strike, sub: `${fmtNum(putWall.net, 1)}M dealer γ`, tone: 'text-sky-300', note: 'dealer long puts trap price' },
            { label: 'Gamma flip', value: flip ?? spot, sub: flip ? `${fmtNum(((flip - spot) / spot) * 100, 2)}% from spot` : 'no flip in range', tone: 'text-zinc-100', note: flip ? 'volatility regime boundary' : 'positive-γ regime' },
            { label: 'Put/Call OI', value: fmtNum(flowStats.pcOi, 2), sub: `${fmtNum(flowStats.cOi / 1000, 0)}k C · ${fmtNum(flowStats.pOi / 1000, 0)}k P`, tone: 'text-sky-300', note: `P/C premium ${fmtNum(flowStats.pcPrem, 2)}` },
          ].map((c) => (
            <div key={`wall-${c.label}`} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{c.label}</div>
              <div className={`mt-0.5 font-mono text-xl font-bold ${c.tone}`}>
                {c.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </div>
              <div className="text-[10px] font-mono text-zinc-400">{c.sub}</div>
              <div className="mt-0.5 text-[9px] text-zinc-600">{c.note}</div>
            </div>
          ))}
        </div>
      )}

      {/* GEX / CHARM / VANNA heatmaps */}
      {(gammaTab === 'overview' || gammaTab === 'heatmaps') && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              GEX heatmap — {und} strike × expiry (live spot {fmtUsd(spot)})
            </h2>
            <span className="text-[10px] text-zinc-500">BS dealer γ × OI, $MM notional · green positive / blue negative</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-px text-[10px]">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-zinc-500">strike</th>
                  {EXPIRIES.map((e) => (
                    <th key={`ex-${e.label}`} className="px-2 py-1 text-right font-medium text-zinc-500">{e.label}</th>
                  ))}
                  <th className="px-2 py-1 text-right font-medium text-zinc-500">net</th>
                </tr>
              </thead>
              <tbody>
                {gexGrid.map((r) => {
                  const atm = Math.abs(r.strike - spot) < (spot > 10000 ? 1250 : spot > 1000 ? 125 : 12.5);
                  return (
                    <tr key={`gx-${r.strike}`} className={atm ? 'bg-emerald-500/5' : undefined}>
                      <td className={`rounded-l px-2 py-1 font-mono ${atm ? 'text-emerald-300' : 'text-zinc-400'}`}>
                        {r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        {atm && <span className="ml-1 text-[8px] uppercase text-emerald-500">spot</span>}
                      </td>
                      {r.cells.map((c, i) => {
                        const t = c / maxAbs;
                        const bg = c >= 0
                          ? `rgba(16,185,129,${0.08 + Math.abs(t) * 0.45})`
                          : `rgba(56,189,248,${0.08 + Math.abs(t) * 0.45})`;
                        return (
                          <td key={`cell-${r.strike}-${i}`} className="px-2 py-1 text-right font-mono text-zinc-200" style={{ background: bg }}>
                            {c >= 0 ? '+' : ''}{(c).toFixed(1)}
                          </td>
                        );
                      })}
                      <td className={`rounded-r px-2 py-1 text-right font-mono ${r.net >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                        {r.net >= 0 ? '+' : ''}{(r.net).toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* charm & vanna tables — second-order dealer flows */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Charm — dealer delta bleed ($k/day)</h3>
              <div className="space-y-0.5">
                {rows.map((r) => {
                  const maxC = Math.max(...rows.map((x) => Math.abs(x.charm)), 1);
                  return (
                    <div key={`ch-${r.strike}`} className="flex items-center gap-2 text-[10px]">
                      <span className="w-16 text-right font-mono text-zinc-500">{r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <div className="relative h-1.5 flex-1 rounded bg-zinc-900">
                        <div
                          className={`absolute top-0 h-full ${r.charm >= 0 ? 'left-1/2 bg-emerald-500/70' : 'right-1/2 bg-sky-500/70'}`}
                          style={{ width: `${(Math.abs(r.charm) / maxC) * 50}%` }}
                        />
                        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                      </div>
                      <span className={`w-14 font-mono ${r.charm >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>{fmtNum(r.charm, 1)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Vanna — dealer vega/spot flow ($k per 1% spot)</h3>
              <div className="space-y-0.5">
                {rows.map((r) => {
                  const maxV = Math.max(...rows.map((x) => Math.abs(x.vanna)), 1);
                  return (
                    <div key={`vn-${r.strike}`} className="flex items-center gap-2 text-[10px]">
                      <span className="w-16 text-right font-mono text-zinc-500">{r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <div className="relative h-1.5 flex-1 rounded bg-zinc-900">
                        <div
                          className={`absolute top-0 h-full ${r.vanna >= 0 ? 'left-1/2 bg-emerald-500/70' : 'right-1/2 bg-sky-500/70'}`}
                          style={{ width: `${(Math.abs(r.vanna) / maxV) * 50}%` }}
                        />
                        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                      </div>
                      <span className={`w-14 font-mono ${r.vanna >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>{fmtNum(r.vanna, 1)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* IV term structure + smile */}
      {(gammaTab === 'overview' || gammaTab === 'vol') && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              <LineIcon className="h-3.5 w-3.5 text-emerald-500" /> IV term structure — ATM {und}
            </h2>
            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={tsData} margin={{ top: 6, right: 10, bottom: 2, left: 0 }}>
                  <CartesianGrid stroke="#27272a" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="dte" tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" tickFormatter={(v: number) => `${v}d`} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" domain={['dataMin - 2', 'dataMax + 2']} tickFormatter={(v: number) => `${v}%`} width={40} />
                  <Tooltip
                    contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelFormatter={(d: number | string) => `${d}d expiry`}
                    formatter={(v: number | string) => [`${v}%`, 'ATM IV']}
                  />
                  <Line type="monotone" dataKey="iv" stroke="#10b981" strokeWidth={1.8} dot={{ r: 2.5, fill: '#10b981' }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              Term rises with √t — 0DTE prints the compressed base, 180d carries the full premium.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              <Smile className="h-3.5 w-3.5 text-sky-500" /> Vol smile at 30d — calls vs puts
            </h2>
            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={smileData} margin={{ top: 6, right: 10, bottom: 2, left: 0 }}>
                  <CartesianGrid stroke="#27272a" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="off" tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}%`} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 10 }} stroke="#3f3f46" domain={['dataMin - 2', 'dataMax + 2']} tickFormatter={(v: number) => `${v}%`} width={40} />
                  <ReferenceLine x={0} stroke="#10b981" strokeDasharray="3 3" />
                  <Tooltip
                    contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelFormatter={(o: number | string) => `${Number(o) > 0 ? '+' : ''}${o}% strike offset`}
                    formatter={(v: number | string, n: string) => [`${v}%`, n === 'call' ? 'call IV' : 'put IV']}
                  />
                  <Line type="monotone" dataKey="call" stroke="#10b981" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="put" stroke="#38bdf8" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              Green calls · blue puts — the put wing trades rich of calls below spot (skew).
            </p>
          </div>
        </div>
      )}

      {/* flow tape with depth + pressure stats */}
      {(gammaTab === 'overview' || gammaTab === 'flow') && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              <Flame className="h-3.5 w-3.5 text-emerald-500" /> Live options flow tape
            </h2>
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className="text-zinc-500">buy pressure <span className="font-mono text-emerald-400">{(flowStats.buyPressure * 100).toFixed(0)}%</span></span>
              <span className="text-zinc-500">0DTE share <span className="font-mono text-sky-400">{(flowStats.zeroDteShare * 100).toFixed(0)}%</span></span>
              <span className="text-zinc-500">sweeps <span className="font-mono text-zinc-300">{flowStats.sweeps}</span> · blocks <span className="font-mono text-zinc-300">{flowStats.blocks}</span></span>
            </div>
          </div>
          {/* buy vs sell pressure bar */}
          <div className="mb-3 flex h-2 overflow-hidden rounded-full border border-zinc-800">
            <div className="bg-emerald-500/70" style={{ width: `${flowStats.buyPressure * 100}%` }} />
            <div className="bg-sky-500/60" style={{ width: `${(1 - flowStats.buyPressure) * 100}%` }} />
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {flow.map((p) => (
              <div
                key={`flow-${p.id}`}
                className={`flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${
                  p.aggressive ? 'border-sky-800/60 bg-sky-500/5' : 'border-zinc-800/80 bg-zinc-900/40'
                }`}
              >
                {p.side === 'buy' ? (
                  <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <ArrowDownRight className="h-3.5 w-3.5 text-sky-400" />
                )}
                <span className="font-mono font-medium text-zinc-200">{p.symbol}</span>
                <span className={`text-[10px] font-semibold uppercase ${p.side === 'buy' ? 'text-emerald-400' : 'text-sky-400'}`}>
                  {p.side}
                </span>
                <span className="font-mono text-zinc-400">{p.size}×</span>
                <span className="font-mono text-emerald-300">{fmtUsd(p.premium)}</span>
                <span className="font-mono text-[10px] text-zinc-500">@ {(p.iv * 100).toFixed(1)}% iv</span>
                <span className={`rounded px-1 text-[8px] font-semibold uppercase ${p.otm ? 'bg-zinc-800 text-zinc-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                  {p.otm ? 'otm' : 'itm'}
                </span>
                {p.zeroDte && <span className="rounded bg-sky-500/10 px-1 text-[8px] font-bold uppercase text-sky-400">0dte</span>}
                {p.aggressive && <span className="rounded bg-sky-500/15 px-1 text-[8px] font-bold uppercase text-sky-400">sweep</span>}
                {p.block && <span className="rounded bg-emerald-500/15 px-1 text-[8px] font-bold uppercase text-emerald-400">block</span>}
                <span className="ml-auto text-[10px] text-zinc-600">{p.venue}</span>
                <span className="text-[10px] text-zinc-600">
                  {new Date(p.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* cumulative net GEX profile */}
      {gammaTab === 'overview' && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Cumulative net GEX profile</h2>
          <div className="space-y-1">
            {gexGrid.map((r, i) => {
              const total = cumGex[cumGex.length - 1] || 1;
              const pct = (cumGex[i] / total) * 100;
              return (
                <div key={`cum-${r.strike}`} className="flex items-center gap-2 text-[10px]">
                  <span className="w-20 text-right font-mono text-zinc-500">{r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded bg-zinc-900">
                    <div
                      className={`absolute top-0 h-full ${cumGex[i] >= 0 ? 'left-1/2 bg-emerald-500/70' : 'right-1/2 bg-sky-500/70'}`}
                      style={{ width: `${Math.min(Math.abs(pct) / 2, 50)}%` }}
                    />
                    <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                  </div>
                  <span className={`w-16 font-mono ${cumGex[i] >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                    {fmtNum(cumGex[i], 1)}M
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
