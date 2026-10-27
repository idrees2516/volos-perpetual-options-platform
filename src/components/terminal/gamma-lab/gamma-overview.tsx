'use client';

// ─────────────────────────────────────────────────────────────────────────────
// GAMMA LAB — Overview tab: gamma exposure by strike, walls, gamma flip,
// max pain, estimated dealer positioning with hedge-flow profile.
// Pure SVG rendering matching the terminal's dark aesthetic.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, Gauge, Info } from 'lucide-react';
import type { GammaProfile } from '@/lib/gamma-flow';
import { fmtNum, fmtUsd } from '@/lib/format';

const C = {
  grid: 'rgba(148,163,184,0.08)',
  gridStrong: 'rgba(148,163,184,0.16)',
  text: '#94a3b8',
  textBright: '#e2e8f0',
  call: '#10b981',
  callFill: 'rgba(16,185,129,0.55)',
  put: '#f43f5e',
  putFill: 'rgba(244,63,94,0.55)',
  cum: '#2dd4bf',
  spot: '#f8fafc',
  flip: '#fbbf24',
  wallCall: '#34d399',
  wallPut: '#fb7185',
  pain: '#a3e635',
};

function fmtGex(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}

interface Props {
  profile: GammaProfile;
}

export function GammaOverview({ profile }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const { rows, levels, dealer, spot, symbol, cumulative } = profile;

  const W = 1180, H = 380;
  const PAD = { l: 64, r: 16, t: 18, b: 46 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const strikes = rows.map((r) => r.strike);
  const kLo = Math.min(...strikes), kHi = Math.max(...strikes);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.netGex), 0)) || 1;
  const cumMax = Math.max(...cumulative.map((c) => Math.abs(c.cum))) || 1;

  const x = (k: number) => PAD.l + ((k - kLo) / (kHi - kLo)) * iw;
  const yCall = (v: number) => PAD.t + ih / 2 - (v / maxAbs) * (ih / 2) * 0.92;
  const yCum = (v: number) => PAD.t + ih - ((v + cumMax) / (2 * cumMax)) * ih;

  const bw = Math.max((iw / rows.length) * 0.62, 2);

  const cumPath = cumulative
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c.strike).toFixed(1)},${yCum(c.cum).toFixed(1)}`)
    .join(' ');

  const kTicks = useMemo(() => {
    const out: number[] = [];
    const rough = (kHi - kLo) / 9;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? mag * 10;
    for (let v = Math.ceil(kLo / step) * step; v <= kHi; v += step) out.push(v);
    return out;
  }, [kLo, kHi]);

  const hoverRow = hover !== null ? rows[hover] : null;

  const keyLevels = [
    { label: 'CALL WALL', value: levels.callWall, color: C.wallCall, desc: 'max dealer call gamma — resistance magnet' },
    { label: 'PUT WALL', value: levels.putWall, color: C.wallPut, desc: 'max dealer put gamma — support magnet' },
    { label: 'GAMMA FLIP', value: levels.gammaFlip, color: C.flip, desc: 'net GEX crosses zero — regime boundary' },
    { label: 'MAX PAIN', value: levels.maxPain, color: C.pain, desc: 'min total option-holder payoff — pin target' },
    { label: 'SPOT', value: spot, color: C.spot, desc: 'live underlying' },
  ];

  return (
    <div className="space-y-3">
      {/* regime banner */}
      <div
        className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${
          levels.regime === 'long-gamma'
            ? 'border-emerald-500/30 bg-emerald-950/20'
            : 'border-rose-500/30 bg-rose-950/20'
        }`}
      >
        <div className="flex items-center gap-2">
          {levels.regime === 'long-gamma' ? (
            <ArrowDownRight className="h-4 w-4 text-emerald-400" />
          ) : (
            <ArrowUpRight className="h-4 w-4 text-rose-400" />
          )}
          <span
            className={`text-xs font-bold tracking-wide ${
              levels.regime === 'long-gamma' ? 'text-emerald-300' : 'text-rose-300'
            }`}
          >
            {dealer.label}
          </span>
        </div>
        <span className="font-mono text-[10px] text-zinc-400">
          net GEX {fmtGex(levels.netGexTotal)} $/1% · spot {fmtNum(spot, spot >= 1000 ? 0 : 2)} vs flip{' '}
          {fmtNum(levels.gammaFlip, levels.gammaFlip >= 1000 ? 0 : 2)}
        </span>
        <p className="w-full text-[10px] leading-relaxed text-zinc-500">{dealer.interpretation}</p>
      </div>

      {/* key levels strip */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {keyLevels.map((k) => (
          <div key={k.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
            <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{k.label}</p>
            <p className="font-mono text-sm font-bold" style={{ color: k.color }}>
              {fmtNum(k.value, k.value >= 1000 ? 0 : k.value >= 100 ? 1 : 2)}
            </p>
            <p className="mt-0.5 text-[8px] leading-tight text-zinc-600">{k.desc}</p>
          </div>
        ))}
      </div>

      {/* GEX chart */}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            <Activity className="h-3.5 w-3.5 text-teal-400" />
            Gamma Exposure by Strike
          </h3>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-[9px] text-zinc-500">
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: C.callFill }} /> dealer call gamma (−)</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: C.putFill }} /> dealer put gamma (+)</span>
            <span className="flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: C.cum }} /> cumulative net</span>
            <span className="flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: C.spot }} /> spot</span>
            <span className="flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: C.flip }} /> flip</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ display: 'block' }}>
          {/* grid */}
          {kTicks.map((k) => (
            <line key={k} x1={x(k)} x2={x(k)} y1={PAD.t} y2={PAD.t + ih} stroke={C.grid} />
          ))}
          {[-1, -0.5, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={PAD.l} x2={W - PAD.r}
              y1={PAD.t + ih / 2 - f * (ih / 2) * 0.92} y2={PAD.t + ih / 2 - f * (ih / 2) * 0.92}
              stroke={C.grid}
            />
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih / 2} y2={PAD.t + ih / 2} stroke={C.gridStrong} strokeDasharray="3,3" />
          <text x={PAD.l + 4} y={PAD.t + ih / 2 - 5} fill={C.text} fontSize={8} fontFamily="monospace">0γ — flip boundary</text>

          {/* bars */}
          {rows.map((r, i) => {
            const cx = x(r.strike);
            const callH = Math.min(Math.abs(r.callGex) / maxAbs, 1) * (ih / 2) * 0.92;
            const putH = Math.min(Math.abs(r.putGex) / maxAbs, 1) * (ih / 2) * 0.92;
            return (
              <g
                key={r.strike}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <rect x={cx - bw / 2 - 2} y={PAD.t} width={bw + 4} height={ih} fill="transparent" />
                <rect
                  x={cx - bw / 2} y={PAD.t + ih / 2} width={bw} height={callH}
                  fill={C.callFill} stroke={C.call} strokeWidth={hover === i ? 1 : 0}
                />
                <rect
                  x={cx - bw / 2} y={PAD.t + ih / 2 - putH} width={bw} height={putH}
                  fill={C.putFill} stroke={C.put} strokeWidth={hover === i ? 1 : 0}
                />
              </g>
            );
          })}

          {/* cumulative net GEX */}
          <path d={cumPath} fill="none" stroke={C.cum} strokeWidth={1.6} opacity={0.9} />

          {/* walls */}
          <line x1={x(levels.callWall)} x2={x(levels.callWall)} y1={PAD.t} y2={PAD.t + ih} stroke={C.wallCall} strokeWidth={1.2} strokeDasharray="5,3" />
          <text x={x(levels.callWall) + 4} y={PAD.t + 10} fill={C.wallCall} fontSize={9} fontFamily="monospace">CALL WALL {fmtNum(levels.callWall, 0)}</text>
          <line x1={x(levels.putWall)} x2={x(levels.putWall)} y1={PAD.t} y2={PAD.t + ih} stroke={C.wallPut} strokeWidth={1.2} strokeDasharray="5,3" />
          <text x={x(levels.putWall) + 4} y={PAD.t + ih - 6} fill={C.wallPut} fontSize={9} fontFamily="monospace">PUT WALL {fmtNum(levels.putWall, 0)}</text>
          <line x1={x(levels.gammaFlip)} x2={x(levels.gammaFlip)} y1={PAD.t} y2={PAD.t + ih} stroke={C.flip} strokeWidth={1.4} strokeDasharray="2,3" />
          <text x={x(levels.gammaFlip) + 4} y={PAD.t + 22} fill={C.flip} fontSize={9} fontFamily="monospace">γ FLIP {fmtNum(levels.gammaFlip, 0)}</text>
          <line x1={x(levels.maxPain)} x2={x(levels.maxPain)} y1={PAD.t} y2={PAD.t + ih} stroke={C.pain} strokeWidth={1} strokeDasharray="1,3" opacity={0.7} />

          {/* spot */}
          <line x1={x(spot)} x2={x(spot)} y1={PAD.t} y2={PAD.t + ih} stroke={C.spot} strokeWidth={1.6} />
          <circle cx={x(spot)} cy={PAD.t + 6} r={3} fill={C.spot} />

          {/* hover readout */}
          {hoverRow && (
            <g>
              <line x1={x(hoverRow.strike)} x2={x(hoverRow.strike)} y1={PAD.t} y2={PAD.t + ih} stroke="rgba(226,232,240,0.25)" />
              <rect x={Math.min(x(hoverRow.strike) + 6, W - 190)} y={PAD.t + 26} width={184} height={58} rx={4} fill="rgba(9,12,18,0.92)" stroke="rgba(148,163,184,0.3)" />
              <text x={Math.min(x(hoverRow.strike) + 12, W - 184)} y={PAD.t + 40} fill={C.textBright} fontSize={9} fontFamily="monospace">
                K {fmtNum(hoverRow.strike, hoverRow.strike >= 1000 ? 0 : 1)}
              </text>
              <text x={Math.min(x(hoverRow.strike) + 12, W - 184)} y={PAD.t + 53} fill={C.call} fontSize={9} fontFamily="monospace">
                call γ {fmtGex(hoverRow.callGex)} · OI {fmtNum(hoverRow.callOi, 0)}
              </text>
              <text x={Math.min(x(hoverRow.strike) + 12, W - 184)} y={PAD.t + 66} fill={C.put} fontSize={9} fontFamily="monospace">
                put γ {fmtGex(hoverRow.putGex)} · OI {fmtNum(hoverRow.putOi, 0)}
              </text>
              <text x={Math.min(x(hoverRow.strike) + 12, W - 184)} y={PAD.t + 79} fill={C.text} fontSize={9} fontFamily="monospace">
                net {fmtGex(hoverRow.netGex)} $/1%
              </text>
            </g>
          )}

          {/* axes */}
          {kTicks.map((k) => (
            <text key={k} x={x(k)} y={H - 28} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="middle">
              {fmtNum(k, k >= 1000 ? 0 : 1)}
            </text>
          ))}
          <text x={PAD.l} y={H - 10} fill={C.text} fontSize={8} fontFamily="monospace">strike →</text>
          <text x={10} y={PAD.t + ih / 2} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="start">
            +{fmtGex(maxAbs)}
          </text>
          <text x={10} y={PAD.t + ih / 2 + 10} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="start">
            −{fmtGex(maxAbs)}
          </text>
        </svg>
      </div>

      {/* dealer positioning detail */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 lg:col-span-2">
          <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            <Gauge className="h-3.5 w-3.5 text-teal-400" /> Estimated Dealer Positioning
          </h3>
          <p className="mb-3 text-[9px] leading-relaxed text-zinc-600">
            Net dealer gamma re-computed across a ±2% spot scan. Above the flip dealers supply liquidity
            into moves; below it their hedging demands liquidity from the market.
          </p>
          <DealerCurves profile={profile} />
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            <Info className="h-3.5 w-3.5 text-teal-400" /> How to read this
          </h3>
          <ul className="space-y-2 text-[9px] leading-relaxed text-zinc-500">
            <li>
              <span className="font-semibold text-zinc-300">GEX</span> — aggregate dealer gamma per strike,
              in dollars per 1% spot move. Dealers are assumed short customer calls (negative, green bars);
              their short puts contribute positive gamma (red bars).
            </li>
            <li>
              <span className="font-semibold text-zinc-300">Call / put walls</span> — strikes of maximum
              dealer gamma. Price gravitates toward them; they act as intraday resistance / support.
            </li>
            <li>
              <span className="font-semibold text-zinc-300">Gamma flip</span> — where cumulative net GEX
              turns negative. Trading below it = short-gamma regime, hedging amplifies moves.
            </li>
            <li>
              <span className="font-semibold text-zinc-300">Max pain</span> — strike minimizing total
              option-holder payoff at expiry; expiry-day pin candidate.
            </li>
            <li className="text-zinc-600">
              Model: naive dealer convention, all expiries aggregated, deterministic OI surface on{' '}
              {symbol.id} × {symbol.multiplier} multiplier.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function DealerCurves({ profile }: { profile: GammaProfile }) {
  const { dealer } = profile;
  const W = 720, H = 200;
  const PAD = { l: 56, r: 10, t: 10, b: 24 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const spots = dealer.curve.map((c) => c.spot);
  const sLo = Math.min(...spots), sHi = Math.max(...spots);
  const gMax = Math.max(...dealer.curve.map((c) => Math.abs(c.gex))) || 1;

  const x = (s: number) => PAD.l + ((s - sLo) / (sHi - sLo)) * iw;
  const y = (g: number) => PAD.t + ih / 2 - (g / gMax) * (ih / 2) * 0.9;

  const gexPath = dealer.curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c.spot).toFixed(1)},${y(c.gex).toFixed(1)}`).join(' ');
  const flip = profile.levels.gammaFlip;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ display: 'block' }}>
      <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih / 2} y2={PAD.t + ih / 2} stroke={C.gridStrong} strokeDasharray="3,3" />
      <line x1={x(flip)} x2={x(flip)} y1={PAD.t} y2={PAD.t + ih} stroke={C.flip} strokeWidth={1.2} strokeDasharray="4,3" />
      <text x={x(flip) + 4} y={PAD.t + 10} fill={C.flip} fontSize={8} fontFamily="monospace">flip {fmtNum(flip, flip >= 1000 ? 0 : 1)}</text>
      <line x1={x(dealer.spot)} x2={x(dealer.spot)} y1={PAD.t} y2={PAD.t + ih} stroke={C.spot} strokeWidth={1.4} />
      <text x={x(dealer.spot) + 4} y={PAD.t + ih - 8} fill={C.spot} fontSize={8} fontFamily="monospace">spot {fmtNum(dealer.spot, 0)}</text>
      <path
        d={`${gexPath} L${x(spots[spots.length - 1]).toFixed(1)},${y(0).toFixed(1)} L${x(spots[0]).toFixed(1)},${y(0).toFixed(1)} Z`}
        fill={dealer.netGex >= 0 ? 'rgba(16,185,129,0.10)' : 'rgba(244,63,94,0.10)'}
      />
      <path d={gexPath} fill="none" stroke={dealer.netGex >= 0 ? C.call : C.put} strokeWidth={1.8} />
      {[sLo, (sLo + sHi) / 2, sHi].map((s) => (
        <text key={s} x={x(s)} y={H - 8} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="middle">
          {fmtNum(s, s >= 1000 ? 0 : 1)}
        </text>
      ))}
      <text x={PAD.l} y={PAD.t + 10} fill={C.text} fontSize={8} fontFamily="monospace">
        net dealer gamma {dealer.netGex >= 0 ? '+' : ''}{fmtGex(dealer.netGex)} $/1%
      </text>
    </svg>
  );
}
