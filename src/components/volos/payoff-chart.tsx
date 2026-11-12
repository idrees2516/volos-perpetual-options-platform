'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PayoffChart — v1.9 expiry payoff with the lognormal PROBABILITY CONE overlay
// (1σ and 2σ bands widening to the structure's horizon) and breakeven markers.
// Pure SVG, no chart lib.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { fmtUsd } from '@/lib/format';

export interface PayoffSeries {
  points: { s: number; pnl: number }[];
  breakevens: number[];
  maxProfit: number;
  maxLoss: number;
  spot: number;
  horizonDays: number;
  atmIv: number;
  netPremium: number;
  size: number;
}

export function PayoffChart({ series, height = 260 }: { series: PayoffSeries; height?: number }) {
  const W = 900, H = height;
  const PL = 56, PR = 14, PT = 14, PB = 26;

  const { xs, ys, path, zeroY, cone1, cone2, area } = useMemo(() => {
    const pts = series.points;
    const lo = pts[0]?.s ?? 0, hi = pts[pts.length - 1]?.s ?? 1;
    const minP = Math.min(0, ...pts.map((p) => p.pnl));
    const maxP = Math.max(0, ...pts.map((p) => p.pnl));
    const pad = (maxP - minP) * 0.08 || 1;
    const yLo = minP - pad, yHi = maxP + pad;
    const x = (s: number) => PL + ((s - lo) / (hi - lo)) * (W - PL - PR);
    const y = (v: number) => PT + (1 - (v - yLo) / (yHi - yLo)) * (H - PT - PB);
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.s).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(' ');
    const zeroY = y(0);

    // probability cone: 1σ / 2σ lognormal bands from spot to horizon
    const t = Math.max(series.horizonDays, 1) / 365;
    const sig = Math.max(series.atmIv, 0.05);
    const steps = 24;
    const c1: string[] = [], c2: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const widen = sig * Math.sqrt(t * f);
      const sLo = series.spot * Math.exp(-widen);
      const sHi = series.spot * Math.exp(widen);
      c1.push(`${x(sLo).toFixed(1)},${(PT + f * (H - PT - PB)).toFixed(1)}`);
      c1.push(`${x(sHi).toFixed(1)},${(PT + f * (H - PT - PB)).toFixed(1)}`);
      const w2 = sig * Math.sqrt(t * f) * 2;
      const s2Lo = series.spot * Math.exp(-w2);
      const s2Hi = series.spot * Math.exp(w2);
      c2.push(`${x(s2Lo).toFixed(1)},${(PT + f * (H - PT - PB)).toFixed(1)}`);
      c2.push(`${x(s2Hi).toFixed(1)},${(PT + f * (H - PT - PB)).toFixed(1)}`);
    }
    // shaded area under the payoff where P&L > 0 (profit zone)
    const posPts = pts.filter((p) => p.pnl >= 0);
    let a = '';
    if (posPts.length > 1) {
      const firstIdx = pts.indexOf(posPts[0]);
      const lastIdx = pts.indexOf(posPts[posPts.length - 1]);
      const seg = pts.slice(firstIdx, lastIdx + 1);
      a = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.s).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(' ');
      a += ` L${x(seg[seg.length - 1].s).toFixed(1)},${zeroY.toFixed(1)} L${x(seg[0].s).toFixed(1)},${zeroY.toFixed(1)} Z`;
    }
    return {
      xs: { lo, hi, x, y },
      ys: { yLo, yHi },
      path: d,
      zeroY,
      cone1: c1.join(' '),
      cone2: c2.join(' '),
      area: a,
    };
  }, [series, H]);

  const { x, y } = xs;
  const gridX = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= 6; i++) out.push(xs.lo + ((xs.hi - xs.lo) * i) / 6);
    return out;
  }, [xs]);
  const gridY = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= 4; i++) out.push(ys.yLo + ((ys.yHi - ys.yLo) * i) / 4);
    return out;
  }, [ys]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="expiry payoff with probability cone">
      {/* grid */}
      {gridY.map((v, i) => (
        <g key={`gy${i}`}>
          <line
            x1={PL} x2={W - PR}
            y1={y(v)} y2={y(v)}
            stroke="#27272a" strokeWidth={0.6}
          />
          <text x={PL - 6} y={y(v) + 3} textAnchor="end" className="fill-zinc-600" fontSize={9} fontFamily="monospace">
            {fmtUsd(v, 0)}
          </text>
        </g>
      ))}
      {gridX.map((s, i) => (
        <text key={`gx${i}`} x={x(s)} y={H - 8} textAnchor="middle" className="fill-zinc-600" fontSize={9} fontFamily="monospace">
          {Math.round(s).toLocaleString()}
        </text>
      ))}

      {/* probability cones */}
      <polygon points={cone2} fill="#f59e0b" opacity={0.05} />
      <polygon points={cone1} fill="#2dd4bf" opacity={0.08} />

      {/* zero line */}
      <line x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} stroke="#52525b" strokeWidth={1} strokeDasharray="4 3" />

      {/* profit area */}
      {area && <path d={area} fill="#2dd4bf" opacity={0.12} />}

      {/* payoff line */}
      <path d={path} fill="none" stroke="#2dd4bf" strokeWidth={1.8} />

      {/* spot marker */}
      <line x1={x(series.spot)} x2={x(series.spot)} y1={PT} y2={H - PB} stroke="#e4e4e7" strokeWidth={0.8} strokeDasharray="2 3" opacity={0.5} />
      <text x={x(series.spot)} y={PT + 10} textAnchor="middle" className="fill-zinc-400" fontSize={9} fontFamily="monospace">
        spot {Math.round(series.spot).toLocaleString()}
      </text>

      {/* breakevens */}
      {series.breakevens.slice(0, 6).map((b, i) => (
        <g key={`be${i}`}>
          <circle cx={x(b)} cy={zeroY} r={3} fill="#f59e0b" />
          <text x={x(b)} y={zeroY - 7} textAnchor="middle" className="fill-amber-400" fontSize={9} fontFamily="monospace">
            {Math.round(b).toLocaleString()}
          </text>
        </g>
      ))}

      {/* cone legend */}
      <g transform={`translate(${W - PR - 170},${PT + 6})`}>
        <rect x={0} y={0} width={170} height={34} rx={4} fill="#18181b" stroke="#27272a" />
        <rect x={8} y={7} width={10} height={6} fill="#2dd4bf" opacity={0.35} />
        <text x={22} y={13} className="fill-zinc-400" fontSize={9}>1σ cone to {series.horizonDays}d</text>
        <rect x={8} y={21} width={10} height={6} fill="#f59e0b" opacity={0.25} />
        <text x={22} y={27} className="fill-zinc-400" fontSize={9}>2σ cone (95%+ mass)</text>
      </g>
    </svg>
  );
}
