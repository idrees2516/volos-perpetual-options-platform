// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · volatility regime — WHERE WE ARE IN THE VOL CYCLE.
//
// IV percentile/rank from our own persisted snapshot history, a realized-vol
// cone (rolling-window RV vs its own historical distribution, the "cheap or
// expensive vs itself" chart), the Deribit DVOL index (current + series), and
// the IV-vs-DVOL-vs-RV triangle. Answers "is vol cheap, rich, expanding or
// compressing — and what has it actually done" without leaving the product.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { getChainSnapshot } from './engine';
import { historicalVolatility, dvolSnapshot } from './deribit';
import { ensureHistory } from './history';

export interface IvStats {
  currentPct: number;
  minPct: number;
  maxPct: number;
  meanPct: number;
  p25Pct: number;
  p50Pct: number;
  p75Pct: number;
  rank: number; // 0..100 percentile
  windowDays: number;
  points: number;
  series: { ts: number; ivPct: number }[];
  note: string;
}

export interface ConeWindow {
  days: number;
  currentPct: number;
  minPct: number;
  p25Pct: number;
  p50Pct: number;
  p75Pct: number;
  maxPct: number;
  cheap: boolean; // current < p25
  rich: boolean; // current > p75
}

export interface VolRegime {
  symbol: string;
  asOf: number;
  spot: number;
  ivStats: IvStats | null;
  cone: ConeWindow[];
  dvol: { currentPct: number; changePct: number | null; series: { ts: number; v: number }[]; source: string } | null;
  triangle: { iv30Pct: number | null; dvolPct: number | null; rv30Pct: number | null; spreadIvRv: number | null; spreadIvDvol: number | null };
  termFrontPct: number | null;
  termCm30Pct: number | null;
  verdict: string;
}

export async function volRegime(symbol: string): Promise<VolRegime> {
  ensureHistory();
  const hasOpts = symbol === 'BTC' || symbol === 'ETH';
  const snap = hasOpts ? await getChainSnapshot(symbol, 30_000).catch(() => null) : null;
  const spot = snap?.spot ?? 0;

  // ── IV percentile from our own snapshot store ──────────────────────────────
  let ivStats: IvStats | null = null;
  if (hasOpts) {
    try {
      const rows = await db.quantSnapshot.findMany({
        where: { symbol, ts: { gte: new Date(Date.now() - 30 * 864e5) }, atmIv30: { not: null } },
        orderBy: { ts: 'asc' },
        take: 8000,
      });
      const series = rows.map((r) => ({ ts: r.ts.getTime(), ivPct: r.atmIv30 as number })).filter((p) => Number.isFinite(p.ivPct));
      if (series.length >= 3) {
        const vals = series.map((p) => p.ivPct);
        const sorted = [...vals].sort((a, b) => a - b);
        const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const current = vals[vals.length - 1];
        const rank = (sorted.filter((v) => v < current).length / sorted.length) * 100;
        ivStats = {
          currentPct: current,
          minPct: sorted[0],
          maxPct: sorted[sorted.length - 1],
          meanPct: vals.reduce((s, v) => s + v, 0) / vals.length,
          p25Pct: q(0.25),
          p50Pct: q(0.5),
          p75Pct: q(0.75),
          rank: Math.round(rank),
          windowDays: 30,
          points: series.length,
          series,
          note: `${series.length} engine snapshots over 30d — density grows as the engine runs`,
        };
      } else if (snap) {
        ivStats = {
          currentPct: snap.iv30vsRv30.iv30Pct,
          minPct: NaN,
          maxPct: NaN,
          meanPct: NaN,
          p25Pct: NaN,
          p50Pct: NaN,
          p75Pct: NaN,
          rank: NaN,
          windowDays: 30,
          points: series.length,
          series,
          note: 'history is still accumulating — snapshots persist every 2 minutes',
        };
      }
    } catch {
      /* db unavailable */
    }
  }

  // ── realized-vol cone (Deribit daily HV series, our own windows) ────────────
  const cone: ConeWindow[] = [];
  try {
    const hv = (await historicalVolatility(symbol, 60 * 60_000).catch(() => null))?.v ?? [];
    const vals = hv.map((p) => p[1]).filter((v) => Number.isFinite(v));
    if (vals.length >= 30) {
      for (const days of [3, 7, 14, 30, 60, 90]) {
        if (vals.length < days) continue;
        const windows: number[] = [];
        for (let i = days; i <= vals.length; i++) {
          let s = 0;
          for (let j = i - days; j < i; j++) s += vals[j];
          windows.push(s / days);
        }
        const sorted = [...windows].sort((a, b) => a - b);
        const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const current = windows[windows.length - 1];
        cone.push({
          days,
          currentPct: current,
          minPct: sorted[0],
          p25Pct: q(0.25),
          p50Pct: q(0.5),
          p75Pct: q(0.75),
          maxPct: sorted[sorted.length - 1],
          cheap: current < q(0.25),
          rich: current > q(0.75),
        });
      }
    }
  } catch {
    /* cone optional */
  }

  // ── DVOL index ─────────────────────────────────────────────────────────────
  let dvol: VolRegime['dvol'] = null;
  try {
    const dv = await dvolSnapshot(symbol);
    if (dv) {
      dvol = {
        currentPct: dv.currentPct,
        changePct: dv.changePct,
        series: dv.series,
        source: 'deribit DVOL futures index (30d implied vol)',
      };
    }
  } catch {
    /* optional */
  }

  const iv30 = snap?.iv30vsRv30.iv30Pct ?? null;
  const rv30 = snap?.iv30vsRv30.rv30Pct ?? null;
  const dvolPct = dvol?.currentPct ?? null;
  const triangle = {
    iv30Pct: iv30,
    dvolPct,
    rv30Pct: rv30,
    spreadIvRv: iv30 != null && rv30 != null ? iv30 - rv30 : null,
    spreadIvDvol: iv30 != null && dvolPct != null ? iv30 - dvolPct : null,
  };

  const verdictParts: string[] = [];
  if (ivStats && Number.isFinite(ivStats.rank)) {
    verdictParts.push(`IV rank ${ivStats.rank}/100 (${ivStats.rank >= 65 ? 'RICH — sellers edge' : ivStats.rank <= 35 ? 'CHEAP — buyers edge' : 'mid-range'})`);
  }
  if (cone.length) {
    const c30 = cone.find((c) => c.days === 30);
    if (c30) verdictParts.push(`RV30 ${c30.cheap ? 'at the CHEAP end of its own cone' : c30.rich ? 'at the RICH end of its cone' : 'mid-cone'}`);
  }
  if (triangle.spreadIvRv != null) {
    verdictParts.push(`IV runs ${triangle.spreadIvRv >= 0 ? '+' : ''}${triangle.spreadIvRv.toFixed(1)} pts ${triangle.spreadIvRv >= 0 ? 'over' : 'under'} realized`);
  }

  return {
    symbol,
    asOf: Date.now(),
    spot,
    ivStats,
    cone,
    dvol,
    triangle,
    termFrontPct: snap?.expiries[0]?.atmIvPct ?? null,
    termCm30Pct: iv30,
    verdict: verdictParts.join(' · ') || 'collecting history — every refresh persists a snapshot',
  };
}
