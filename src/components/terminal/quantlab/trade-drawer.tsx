'use client';

// -----------------------------------------------------------------------------
// quantlab/trade-drawer — ORDER ANATOMY DRAWER: click ANY print on the live
// tape, any whale, or any chain cell → the full anatomy of that exact order:
// live quote + greeks, IV vs the expiry's own distribution, premium context,
// "if you take this trade" risk (greeks, premium, notional), and one-click
// paper execution. This is what "control on each and every order" means.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { b76Call, b76Put } from '@/lib/quant/math';
import { useQuant } from './use-quant';
import { EmptyNote, ErrNote, LiveDot, Pill } from './quant-viz';
import { CrosshairChart } from './viz-deep';

export interface InspectTarget {
  instrument: string; // BTC-27NOV26-102000-C
  symbol: string;
  expiry: string; // ISO 2026-11-27
  strike: number;
  kind: 'call' | 'put';
  from?: {
    kind: 'tape' | 'chain';
    side?: 'buy' | 'sell';
    premiumUsd?: number;
    amount?: number;
    ivPct?: number | null;
    ts?: number;
  };
}

interface Side {
  bid: number;
  ask: number;
  mid: number;
  mark: number;
  ivPct: number;
  oi: number;
  oiUsd: number;
  volumeUsd: number;
  delta: number;
  gamma: number;
  vegaUsd: number;
  thetaUsd: number;
  spreadUsd: number;
}
interface ChainData {
  spot: number;
  expiry: string;
  dte: number | null;
  rows: { strike: number; call: Side | null; put: Side | null }[];
}

const MONTH_CODES: Record<string, string> = { '01': 'JAN', '02': 'FEB', '03': 'MAR', '04': 'APR', '05': 'MAY', '06': 'JUN', '07': 'JUL', '08': 'AUG', '09': 'SEP', '10': 'OCT', '11': 'NOV', '12': 'DEC' };

/** ISO "2026-11-27" → Deribit label "27NOV26" (what the paper engine expects). */
export function isoToDeribitLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)}${MONTH_CODES[m] ?? 'JAN'}${y.slice(2)}`;
}

export function TradeDrawer({ target, onClose, onScenario }: { target: InspectTarget | null; onClose: () => void; onScenario?: (t: InspectTarget) => void }) {
  const [qty, setQty] = useState('1');
  const [side, setSide] = useState<'buy' | 'sell'>(target?.from?.side === 'sell' ? 'sell' : 'buy');
  const [orderState, setOrderState] = useState<{ ok: boolean; msg: string } | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    setSide(target?.from?.side === 'sell' ? 'sell' : 'buy');
    setQty('1');
    setOrderState(null);
  }, [target?.instrument, target?.from?.side]);

  const chain = useQuant<ChainData>('/chain', { symbol: target?.symbol, view: 'chain', expiry: target?.expiry }, { pollMs: 6000, enabled: Boolean(target) });
  const row = target ? chain.data?.rows.find((r) => r.strike === target.strike) : undefined;
  const quote = target ? (target.kind === 'call' ? row?.call : row?.put) ?? null : null;
  const spot = chain.data?.spot ?? 0;
  const dte = chain.data?.dte ?? 0;

  // IV percentile of this strike within its own expiry
  const ivRankInExpiry = useMemo(() => {
    const rows = chain.data?.rows ?? [];
    const ivs = rows.flatMap((r) => [r.call?.ivPct, r.put?.ivPct]).filter((v): v is number => v != null && Number.isFinite(v));
    if (!quote || ivs.length < 6) return null;
    const sorted = [...ivs].sort((a, b) => a - b);
    const rank = sorted.filter((v) => v < quote.ivPct).length / sorted.length;
    const atmIv = sorted[Math.floor(sorted.length / 2)];
    return { rank: Math.round(rank * 100), atmIv, diff: quote.ivPct - atmIv };
  }, [chain.data, quote]);

  // payoff if the user takes this trade at the live mark
  const payoff = useMemo(() => {
    if (!quote || !target || !(spot > 0)) return [];
    const T = Math.max(dte, 0.05) / 365;
    const signed = side === 'buy' ? 1 : -1;
    const q = Math.max(0.1, Number(qty) || 1);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 50; i++) {
      const S = spot * (0.75 + (i / 50) * 0.5);
      const v = target.kind === 'call' ? b76Call(S, target.strike, T, quote.ivPct / 100) : b76Put(S, target.strike, T, quote.ivPct / 100);
      pts.push({ x: S, y: signed * q * (v - quote.mid) * S });
    }
    return pts;
  }, [quote, target, spot, dte, side, qty]);

  const takeQty = Math.max(0.1, Number(qty) || 1);
  const premiumUsd = quote ? quote.mid * takeQty * spot : 0;
  const notionalUsd = target ? target.strike * takeQty * spot : 0;

  const placePaper = async () => {
    if (!target) return;
    setPlacing(true);
    setOrderState(null);
    try {
      const res = await fetch('/api/paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'order',
          venue: 'auto',
          asset: target.symbol,
          expiry: isoToDeribitLabel(target.expiry),
          strike: target.strike,
          kind: target.kind,
          side,
          qty: takeQty,
          type: 'market',
          strategyTag: 'quantlab-drawer',
        }),
      });
      const env = (await res.json()) as { ok: boolean; error?: string; fill?: { price: number; fee: number; spotAtFill: number }; rested?: unknown };
      if (env.ok) {
        setOrderState({
          ok: true,
          msg: env.rested ? 'limit resting' : `filled @ ${env.fill?.price.toFixed(4)} (fee ${fmtUsd(env.fill?.fee ?? 0)}) — manage it in the Risk tab`,
        });
      } else {
        setOrderState({ ok: false, msg: env.error ?? 'order rejected' });
      }
    } catch (e) {
      setOrderState({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setPlacing(false);
    }
  };

  if (!target) return null;
  const t = target;

  return (
    <>
      {/* scrim */}
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      {/* drawer */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[400px] flex-col border-l border-zinc-800 bg-zinc-950/97 shadow-2xl">
        <header className="flex items-start gap-2 border-b border-zinc-800/80 px-3 py-2.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-mono text-[11px] font-bold">
              <span className={t.kind === 'call' ? 'text-emerald-300' : 'text-rose-300'}>{t.instrument.replace(`${t.symbol}-`, '')}</span>
              {t.from?.kind === 'tape' && <Pill tone="amber">from tape</Pill>}
              {t.from?.kind === 'chain' && <Pill tone="teal">from chain</Pill>}
            </p>
            <p className="mt-0.5 text-[8.5px] text-zinc-500">
              {t.symbol} · {t.kind} · strike {fmtNum(t.strike, 0)} · expires {t.expiry} ({(dte || 0).toFixed(1)}d)
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <LiveDot ok={!chain.error} />
            <button onClick={onClose} className="rounded-md border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-200">
              esc ✕
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
          <ErrNote error={chain.error} />

          {/* live quote + greeks */}
          {quote ? (
            <section className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-600">live quote & greeks (Black-76 on venue marks)</p>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5 font-mono text-[9px]">
                {[
                  { l: 'bid', v: quote.bid.toFixed(4), c: 'text-emerald-300/80' },
                  { l: 'mid', v: quote.mid.toFixed(4), c: 'text-zinc-100 font-bold' },
                  { l: 'ask', v: quote.ask.toFixed(4), c: 'text-rose-300/80' },
                  { l: 'mark', v: quote.mark.toFixed(4), c: 'text-zinc-300' },
                  { l: 'iv', v: `${quote.ivPct.toFixed(1)}%`, c: 'text-teal-300' },
                  { l: 'spread', v: fmtUsd(quote.spreadUsd, { compact: true }), c: 'text-zinc-400' },
                  { l: 'delta', v: quote.delta.toFixed(3), c: 'text-zinc-300' },
                  { l: 'gamma', v: quote.gamma.toExponential(2), c: 'text-zinc-400' },
                  { l: 'vega $', v: quote.vegaUsd.toFixed(0), c: 'text-zinc-300' },
                  { l: 'theta $/d', v: quote.thetaUsd.toFixed(1), c: 'text-rose-300/80' },
                  { l: 'oi', v: fmtNum(quote.oi, 0), c: 'text-zinc-300' },
                  { l: 'oi $', v: fmtUsd(quote.oiUsd, { compact: true }), c: 'text-zinc-400' },
                  { l: 'vol $ 24h', v: fmtUsd(quote.volumeUsd, { compact: true }), c: 'text-zinc-400' },
                  { l: 'spot', v: fmtNum(spot, 0), c: 'text-zinc-200' },
                  { l: 'moneyness', v: `${((t.strike / spot - 1) * 100).toFixed(1)}%`, c: t.strike >= spot ? 'text-emerald-300/80' : 'text-rose-300/80' },
                ].map((c) => (
                  <div key={c.l} className="rounded bg-zinc-950/60 px-1.5 py-1">
                    <p className="text-[7px] uppercase tracking-wide text-zinc-600">{c.l}</p>
                    <p className={c.c}>{c.v}</p>
                  </div>
                ))}
              </div>
              {ivRankInExpiry && (
                <p className="mt-1.5 font-mono text-[8.5px] text-zinc-500">
                  iv vs this expiry: <span className="text-zinc-300">p{ivRankInExpiry.rank}</span> of strikes ·{' '}
                  {ivRankInExpiry.diff >= 0 ? (
                    <span className="text-amber-300/90">+{ivRankInExpiry.diff.toFixed(1)} pts vs atm-median (rich)</span>
                  ) : (
                    <span className="text-emerald-300/90">{ivRankInExpiry.diff.toFixed(1)} pts vs atm-median (cheap)</span>
                  )}
                </p>
              )}
            </section>
          ) : (
            <EmptyNote>{chain.loading ? 'fetching the live contract…' : 'contract not found in the live chain (expired or delisted)'}</EmptyNote>
          )}

          {/* tape context */}
          {t.from?.kind === 'tape' && t.from.premiumUsd != null && (
            <section className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-2.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-amber-500/80">the print that opened this</p>
              <div className="mt-1 grid grid-cols-2 gap-1.5 font-mono text-[9px] text-zinc-300">
                <p>taker: <span className={t.from.side === 'buy' ? 'font-bold text-emerald-400' : 'font-bold text-rose-400'}>{t.from.side?.toUpperCase()}</span></p>
                <p>size: {t.from.amount?.toFixed(1)} contracts</p>
                <p>premium: <span className="text-zinc-100">{fmtUsd(t.from.premiumUsd, { compact: true })}</span></p>
                <p>iv at print: {t.from.ivPct != null ? `${t.from.ivPct.toFixed(1)}%` : '—'}</p>
                {t.from.ts != null && <p className="col-span-2 text-zinc-500">{new Date(t.from.ts).toLocaleString()}</p>}
                {quote && t.from.ivPct != null && (
                  <p className="col-span-2 text-zinc-500">
                    iv since print: {(quote.ivPct - t.from.ivPct >= 0 ? '+' : '') + (quote.ivPct - t.from.ivPct).toFixed(1)} pts ·{' '}
                    mark move {((quote.mark / (t.from.premiumUsd / Math.max(t.from.amount ?? 1, 1e-9) / spot) - 1) * 100).toFixed(1) > 0 ? 'in the taker\'s favor' : 'against the taker'}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* take this trade */}
          {quote && (
            <section className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-600">take this order — control it like it was yours</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950/60 p-0.5">
                  {(['buy', 'sell'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSide(s)}
                      className={`rounded px-2.5 py-0.5 text-[9.5px] font-bold uppercase transition ${side === s ? (s === 'buy' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-rose-900/60 text-rose-300') : 'text-zinc-600 hover:text-zinc-300'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <input
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  inputMode="decimal"
                  className="w-20 rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-700"
                  placeholder="qty"
                />
                <span className="font-mono text-[9px] text-zinc-500">
                  {side === 'buy' ? 'cost' : 'collect'} <span className="text-zinc-200">{fmtUsd(premiumUsd, { compact: true })}</span> · notional {fmtUsd(notionalUsd, { compact: true })}
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5 font-mono text-[9px]">
                {[
                  { l: 'δ $', v: fmtUsd(quote.delta * spot * takeQty * (side === 'buy' ? 1 : -1), { compact: true, sign: true }) },
                  { l: 'γ $/1%', v: fmtUsd(quote.gamma * spot * spot * 0.01 * takeQty * (side === 'buy' ? 1 : -1), { compact: true, sign: true }) },
                  { l: 'ν $/pt', v: fmtUsd(quote.vegaUsd * takeQty * (side === 'buy' ? 1 : -1), { compact: true, sign: true }) },
                  { l: 'θ $/d', v: fmtUsd(quote.thetaUsd * takeQty * (side === 'buy' ? 1 : -1), { compact: true, sign: true }) },
                ].map((c) => (
                  <div key={c.l} className="rounded bg-zinc-950/60 px-1.5 py-1">
                    <p className="text-[7px] uppercase tracking-wide text-zinc-600">{c.l}</p>
                    <p className="text-zinc-200">{c.v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={placePaper}
                  disabled={placing}
                  className={`rounded-md border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide transition disabled:opacity-50 ${side === 'buy' ? 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300 hover:bg-emerald-900/50' : 'border-rose-700/60 bg-rose-950/50 text-rose-300 hover:bg-rose-900/50'}`}
                >
                  {placing ? 'routing…' : `paper ${side} ${takeQty} @ market`}
                </button>
                <button onClick={() => onScenario?.(t)} className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-[9.5px] text-zinc-400 hover:text-zinc-200">
                  send to what-if →
                </button>
              </div>
              {orderState && (
                <p className={`mt-1.5 rounded-md border px-2 py-1 font-mono text-[9px] ${orderState.ok ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-300' : 'border-rose-800/60 bg-rose-950/30 text-rose-300'}`}>
                  {orderState.msg}
                </p>
              )}
            </section>
          )}

          {/* payoff preview */}
          {payoff.length > 3 && (
            <section className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-600">your P&L at expiry · {side} {takeQty}</p>
              <CrosshairChart
                height={170}
                series={[{ label: 'p&L', points: payoff, area: true }]}
                yFormat={(v) => fmtUsd(v, { compact: true })}
                xFormat={(v) => fmtNum(v, 0)}
                yZero
                spot={{ x: t.strike, y: 0 }}
              />
              <p className="mt-1 text-[8.5px] text-zinc-600">dashed = strike · premium at live mark · hover to probe</p>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
