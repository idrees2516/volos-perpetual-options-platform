// GET /api/quant/greeks?symbol=BTC&greek=gamma&view=profile|surface|trace|summary
import { getChainSnapshot } from '@/lib/quant/engine';
import { guard, qOk, searchParams } from '@/lib/quant/http';
import { b76Greeks } from '@/lib/quant/math';
import type { ChainSnapshot, OptionRow } from '@/lib/quant/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GREEKS = ['gamma', 'delta', 'vega', 'theta', 'vanna', 'charm'] as const;
type GreekId = (typeof GREEKS)[number];

/** Dealer-signed exposure for one greek across the chain, per strike. */
function profile(rows: OptionRow[], greek: GreekId) {
  const m = new Map<number, { strike: number; call: number; put: number; net: number }>();
  for (const r of rows) {
    const raw =
      greek === 'gamma' ? r.gamma * r.oi * r.forward * r.forward * 0.01
      : greek === 'delta' ? r.delta * r.oi * r.forward
      : greek === 'vega' ? r.vega * r.oi
      : greek === 'theta' ? r.thetaUsd * r.oi
      : greek === 'vanna' ? r.vanna * r.oi * r.forward * 0.01
      : r.charm * r.oi * r.forward;
    const a = m.get(r.strike) ?? { strike: r.strike, call: 0, put: 0, net: 0 };
    if (r.isCall) a.call += raw;
    else a.put += raw;
    m.set(r.strike, a);
  }
  return [...m.values()]
    .map((a) => ({ ...a, net: a.call - a.put }))
    .sort((a, b) => a.strike - b.strike);
}

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const greek = (GREEKS.includes((sp.get('greek') ?? 'gamma') as GreekId) ? sp.get('greek') : 'gamma') as GreekId;
    const view = sp.get('view') ?? 'profile';

    const snap: ChainSnapshot = await getChainSnapshot(symbol);
    const meta = { symbol, computeMs: Date.now() - t0, cacheAgeMs: Date.now() - snap.asOf, sources: ['deribit'] };

    if (view === 'trace') {
      if (greek !== 'gamma') {
        // recompute TRACE for the requested greek across the spot grid
        const spotGrid = snap.trace.spotGrid;
        const shifts = snap.trace.timeShiftsPct;
        const YEAR_MS = 365 * 24 * 3600 * 1000;
        const net: number[][] = [];
        for (const shift of shifts) {
          const per: number[] = [];
          for (const S of spotGrid) {
            let total = 0;
            for (const r of snap.rows) {
              const T = Math.max(r.expiryTs - Date.now(), 15 * 60_000) / YEAR_MS;
              const Tn = Math.max(T * (1 - shift), 15 * 60_000 / YEAR_MS);
              const Fn = r.forward * (S / snap.spot);
              if (!(r.iv > 0)) continue;
              const g = b76Greeks(Fn, r.strike, Tn, r.iv, r.isCall);
              const raw =
                greek === 'delta' ? g.delta * r.oi * Fn
                : greek === 'vega' ? (g.vega / 100) * Fn * r.oi
                : greek === 'theta' ? (g.theta / 365) * Fn * r.oi
                : greek === 'vanna' ? g.vanna * r.oi * Fn * 0.01
                : g.charm * r.oi * Fn;
              if (Number.isFinite(raw)) total += (r.isCall ? 1 : -1) * raw;
            }
            per.push(total);
          }
          net.push(per);
        }
        return qOk({ symbol, greek, asOf: snap.asOf, spot: snap.spot, spotGrid, timeShiftsPct: shifts, net, note: 'projected dealer exposure across spot × time-decay (native Black-76 recompute)' }, meta);
      }
      return qOk(
        {
          symbol,
          greek,
          asOf: snap.asOf,
          spot: snap.spot,
          spotGrid: snap.trace.spotGrid,
          timeShiftsPct: snap.trace.timeShiftsPct,
          net: snap.trace.netGex,
          flips: snap.trace.flipByTime,
          note: 'TRACE: net dealer gamma (USD per 1% move) projected across spot ±12% and 0/25/50/75/100% time decay',
        },
        meta,
      );
    }

    if (view === 'surface') {
      // greek × strike × expiry grid (top strikes by OI)
      const heatStrikes = snap.heatmap.strikes;
      const expiries = snap.heatmap.expiries;
      const grid: number[][] = [];
      for (const e of expiries) {
        const eRows = snap.rows.filter((r) => r.expiry === e);
        grid.push(
          heatStrikes.map((k) => {
            const arr = eRows.filter((r) => r.strike === k);
            const raw = arr.reduce((s, r) => {
              const v =
                greek === 'gamma' ? r.gamma * r.oi * r.forward * r.forward * 0.01
                : greek === 'delta' ? r.delta * r.oi * r.forward
                : greek === 'vega' ? r.vega * r.oi
                : greek === 'theta' ? r.thetaUsd * r.oi
                : greek === 'vanna' ? r.vanna * r.oi * r.forward * 0.01
                : r.charm * r.oi * r.forward;
              return s + (r.isCall ? v : -v);
            }, 0);
            return raw;
          }),
        );
      }
      return qOk({ symbol, greek, asOf: snap.asOf, spot: snap.spot, strikes: heatStrikes, expiries, grid }, meta);
    }

    const prof = profile(snap.rows, greek);
    if (view === 'summary') {
      const total = prof.reduce((s, p) => s + p.net, 0);
      const abs = prof.reduce((s, p) => s + Math.abs(p.net), 0);
      const top = [...prof].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 10);
      return qOk({ symbol, greek, asOf: snap.asOf, spot: snap.spot, totalNet: total, totalAbs: abs, topStrikes: top, unit: 'dealer-signed exposure (calls +, puts −)' }, meta);
    }
    return qOk({ symbol, greek, asOf: snap.asOf, spot: snap.spot, profile: prof, unit: 'dealer-signed exposure (calls +, puts −)' }, meta);
  });
}
