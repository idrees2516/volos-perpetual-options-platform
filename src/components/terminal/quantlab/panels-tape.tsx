'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-tape — Tape · LIVE: server-sent-events stream of Deribit
// option prints (pushed the moment the engine's 5s poller sees them), with
// filters, whale highlighting and window aggregates.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { DataTable, EmptyNote, ErrNote, Panel, Pill, Segmented, StatGrid } from './quant-viz';

interface Print {
  id: string;
  ts: number;
  instrument: string;
  strike: number;
  expiry: string;
  isCall: boolean;
  side: 'buy' | 'sell';
  premiumUsd: number;
  amount: number;
  ivPct: number | null;
  venue: string;
}
interface Agg {
  windowHours: number;
  prints: number;
  premiumUsd: number;
  buyPremiumUsd: number;
  sellPremiumUsd: number;
  callPremiumUsd: number;
  putPremiumUsd: number;
  imbalance: number;
  whaleCount: number;
  whales: Print[];
  byStrike: { strike: number; buyUsd: number; sellUsd: number; netUsd: number; premiumUsd: number }[];
  byExpiry: { expiry: string; premiumUsd: number; prints: number }[];
}

export function TapePanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  if (!hasOptions) return <EmptyNote>{symbol} has no options tape — Deribit lists BTC/ETH options.</EmptyNote>;
  const [hours, setHours] = useState<'6' | '12' | '24' | '48'>('24');
  const [minPremium, setMinPremium] = useState<string>('');
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [kind, setKind] = useState<'all' | 'call' | 'put'>('all');
  const [live, setLive] = useState(true);
  const [livePrints, setLivePrints] = useState<Print[]>([]);
  const [streamOk, setStreamOk] = useState(false);
  const [lastEvent, setLastEvent] = useState<number | null>(null);
  const agg = useQuant<Agg>('/tape', { symbol, hours }, { pollMs: 8000 });
  const minNum = Number(minPremium.replace(/,/g, '')) || 0;
  const whaleUsd = 100_000;

  // SSE live stream
  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/quant/tape/stream?symbol=${symbol}`);
    es.addEventListener('hello', () => setStreamOk(true));
    es.addEventListener('ping', () => setLastEvent(Date.now()));
    es.addEventListener('print', (ev) => {
      try {
        const prints = JSON.parse((ev as MessageEvent).data) as Print[];
        setLastEvent(Date.now());
        setLivePrints((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const fresh = prints.filter((p) => !seen.has(p.id));
          return [...fresh, ...prev].slice(0, 160);
        });
      } catch {
        /* ignore malformed frame */
      }
    });
    es.onerror = () => setStreamOk(false);
    return () => es.close();
  }, [symbol, live]);

  const prints = livePrints
    .filter((p) => p.premiumUsd >= Math.max(minNum, 1000))
    .filter((p) => (side === 'all' ? true : p.side === side))
    .filter((p) => (kind === 'all' ? true : (kind === 'call') === p.isCall));

  const a = agg.data;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2">
        <span className={`flex items-center gap-1.5 text-[10px] font-semibold ${streamOk && live ? 'text-emerald-300' : 'text-zinc-500'}`}>
          <span className="relative flex h-2 w-2">
            {live && streamOk && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${live && streamOk ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          </span>
          {live ? (streamOk ? 'SSE stream · connected' : 'connecting…') : 'stream paused'}
        </span>
        <button
          onClick={() => setLive((v) => !v)}
          className={`rounded-md border px-2 py-0.5 text-[9.5px] font-medium transition ${live ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
        >
          {live ? 'pause' : 'resume'}
        </button>
        {lastEvent && <span className="font-mono text-[8.5px] text-zinc-600">last print {Math.max(0, Math.round((Date.now() - lastEvent) / 1000))}s ago</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Segmented value={hours} onChange={setHours} options={[{ id: '6', label: '6h' }, { id: '12', label: '12h' }, { id: '24', label: '24h' }, { id: '48', label: '48h' }]} />
          <Segmented value={side} onChange={setSide} options={[{ id: 'all', label: 'Both' }, { id: 'buy', label: 'Buys' }, { id: 'sell', label: 'Sells' }]} />
          <Segmented value={kind} onChange={setKind} options={[{ id: 'all', label: 'C+P' }, { id: 'call', label: 'Calls' }, { id: 'put', label: 'Puts' }]} />
          <input
            value={minPremium}
            onChange={(e) => setMinPremium(e.target.value)}
            placeholder="min $"
            inputMode="numeric"
            className="w-20 rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-700"
          />
        </div>
      </div>

      <ErrNote error={agg.error} />
      {a && (
        <Panel title={`${hours}h Tape Aggregates`} sub="deribit · the only free keyless options tape" right={<Pill tone="teal">{a.prints} prints</Pill>}>
          <StatGrid
            cols={4}
            stats={[
              { label: 'premium traded', value: fmtUsd(a.premiumUsd, { compact: true }), tone: 'teal', sub: `${a.prints} prints` },
              { label: 'buy premium', value: fmtUsd(a.buyPremiumUsd, { compact: true }), sub: 'taker bought' },
              { label: 'sell premium', value: fmtUsd(a.sellPremiumUsd, { compact: true }), sub: 'taker sold' },
              { label: 'imbalance', value: `${(a.imbalance * 100).toFixed(1)}%`, tone: a.imbalance >= 0 ? 'emerald' : 'rose', sub: '(buy−sell)/total' },
              { label: 'call premium', value: fmtUsd(a.callPremiumUsd, { compact: true }), sub: `${a.premiumUsd > 0 ? ((a.callPremiumUsd / a.premiumUsd) * 100).toFixed(0) : '—'}% of tape` },
              { label: 'put premium', value: fmtUsd(a.putPremiumUsd, { compact: true }), sub: `${a.premiumUsd > 0 ? ((a.putPremiumUsd / a.premiumUsd) * 100).toFixed(0) : '—'}% of tape` },
              { label: 'whale prints', value: a.whaleCount, tone: 'amber', sub: `≥ ${fmtUsd(whaleUsd, { compact: true })}` },
              { label: 'prints/hour', value: (a.prints / a.windowHours).toFixed(1), sub: 'tape velocity' },
            ]}
          />
        </Panel>
      )}

      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="Live Prints" sub="pushed via SSE within seconds of the venue match" right={<Pill>{prints.length} shown</Pill>}>
          <div className="max-h-[420px] overflow-y-auto">
            {prints.length ? (
              <table className="w-full text-[9px]">
                <thead className="sticky top-0 bg-zinc-950/90 backdrop-blur">
                  <tr className="border-b border-zinc-800/70 text-[7.5px] uppercase tracking-[0.1em] text-zinc-600">
                    {['time', 'instrument', 'side', 'prem $', 'iv', 'size'].map((h) => (
                      <th key={h} className={`px-1 py-1 font-semibold ${h === 'instrument' ? 'text-left' : 'text-right'}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {prints.map((p) => (
                    <tr key={p.id} className={`border-b border-zinc-900/60 hover:bg-zinc-900/40 ${p.premiumUsd >= whaleUsd ? 'bg-amber-950/20' : ''}`}>
                      <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{new Date(p.ts).toLocaleTimeString(undefined, { hour12: false })}</td>
                      <td className="px-1 py-0.5 text-left font-mono">
                        <span className={p.isCall ? 'text-emerald-300' : 'text-rose-300'}>{p.instrument.replace(`${symbol}-`, '')}</span>
                        {p.premiumUsd >= whaleUsd && <span className="ml-1 text-[7.5px] font-bold uppercase text-amber-400">whale</span>}
                      </td>
                      <td className="px-1 py-0.5 text-right">
                        <span className={`font-mono text-[8.5px] font-bold ${p.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{p.side.toUpperCase()}</span>
                      </td>
                      <td className="px-1 py-0.5 text-right font-mono text-zinc-200">{fmtUsd(p.premiumUsd, { compact: true })}</td>
                      <td className="px-1 py-0.5 text-right font-mono text-zinc-400">{p.ivPct != null ? `${p.ivPct.toFixed(0)}%` : '—'}</td>
                      <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{p.amount.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyNote>{live ? 'waiting for prints… ( Deribit matches arrive as they happen )' : 'stream paused'}</EmptyNote>
            )}
          </div>
        </Panel>

        <div className="space-y-2">
          <Panel title="Whale Prints" sub={`≥ ${fmtUsd(whaleUsd, { compact: true })} premium`}>
            {a?.whales?.length ? (
              <DataTable
                rows={a.whales}
                maxRows={8}
                rowKey={(w) => w.id}
                columns={[
                  { key: 'time', label: 'time', render: (w) => new Date(w.ts).toLocaleTimeString(undefined, { hour12: false }) },
                  { key: 'inst', label: 'instrument', align: 'l', render: (w) => <span className={w.isCall ? 'text-emerald-300' : 'text-rose-300'}>{w.instrument.replace(`${symbol}-`, '')}</span> },
                  { key: 'side', label: 'side', render: (w) => <span className={w.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{w.side}</span> },
                  { key: 'prem', label: 'prem $', render: (w) => fmtUsd(w.premiumUsd, { compact: true }) },
                  { key: 'iv', label: 'iv', render: (w) => (w.ivPct != null ? `${w.ivPct.toFixed(0)}%` : '—') },
                ]}
              />
            ) : (
              <EmptyNote>no whales in window</EmptyNote>
            )}
          </Panel>

          <Panel title="Premium by Strike" sub="buy vs sell (taker) per strike">
            {a?.byStrike?.length ? (
              <div className="space-y-0.5">
                {a.byStrike.slice(0, 12).map((s) => {
                  const max = Math.max(...a.byStrike.map((x) => x.premiumUsd), 1);
                  return (
                    <div key={s.strike} className="flex items-center gap-1.5">
                      <span className="w-16 shrink-0 text-right font-mono text-[9px] text-zinc-500">{fmtNum(s.strike, 0)}</span>
                      <div className="relative h-3 flex-1">
                        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                        <div className="absolute left-1/2 top-0 h-full rounded-sm bg-emerald-500/60" style={{ width: `${(s.buyUsd / max) * 50}%` }} />
                        <div className="absolute right-1/2 top-0 h-full rounded-sm bg-rose-500/60" style={{ width: `${(s.sellUsd / max) * 50}%` }} />
                      </div>
                      <span className="w-16 shrink-0 text-right font-mono text-[8.5px] text-zinc-400">{fmtUsd(s.premiumUsd, { compact: true })}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyNote>—</EmptyNote>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Premium tide + flow by strike (used by the OI & Flow tab). */
export function FlowPanel({ symbol }: { symbol: string }) {
  const tide = useQuant<{ tides: { hours: number; premiumUsd: number; netUsd: number; imbalance: number; prints: number }[] }>('/oi', { symbol, view: 'premium' }, { pollMs: 20000 });
  const flow = useQuant<{ byStrike: { strike: number; callBuy: number; callSell: number; putBuy: number; putSell: number; netUsd: number }[] }>('/tape', { symbol, view: 'flow' }, { pollMs: 30000 });
  return (
    <div className="grid gap-2 xl:grid-cols-2">
      <Panel title="Premium Tide" sub="net taker premium (buy − sell) over trailing windows" right={<Pill tone="teal">live tape</Pill>}>
        {tide.data?.tides?.length ? (
          <div className="space-y-1.5">
            {tide.data.tides.map((t) => (
              <div key={t.hours} className="flex items-center gap-2">
                <span className="w-10 font-mono text-[9.5px] text-zinc-500">{t.hours}h</span>
                <div className="relative h-4 flex-1">
                  <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                  {t.netUsd >= 0 ? (
                    <div className="absolute left-1/2 top-0 h-full rounded-sm bg-emerald-500/70" style={{ width: `${Math.min(50, (Math.abs(t.netUsd) / (t.premiumUsd || 1)) * 50)}%` }} />
                  ) : (
                    <div className="absolute right-1/2 top-0 h-full rounded-sm bg-rose-500/70" style={{ width: `${Math.min(50, (Math.abs(t.netUsd) / (t.premiumUsd || 1)) * 50)}%` }} />
                  )}
                </div>
                <span className={`w-24 text-right font-mono text-[9.5px] ${t.netUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtUsd(t.netUsd, { compact: true, sign: true })}</span>
                <span className="w-16 text-right font-mono text-[8.5px] text-zinc-600">{(t.imbalance * 100).toFixed(0)}% imb</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyNote>{tide.loading ? 'loading…' : '—'}</EmptyNote>
        )}
      </Panel>
      <Panel title="Flow by Strike · 7d" sub="cumulative aggressor premium on open contracts">
        {flow.data?.byStrike?.length ? (
          <div className="space-y-0.5">
            {flow.data.byStrike.slice(0, 14).map((s) => {
              const max = Math.max(...flow.data!.byStrike.map((x) => Math.abs(x.netUsd)), 1);
              const w = (Math.abs(s.netUsd) / max) * 50;
              return (
                <div key={s.strike} className="flex items-center gap-1.5">
                  <span className="w-16 shrink-0 text-right font-mono text-[9px] text-zinc-500">{fmtNum(s.strike, 0)}</span>
                  <div className="relative h-3 flex-1">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                    {s.netUsd >= 0 ? (
                      <div className="absolute left-1/2 top-0 h-full rounded-sm bg-teal-500/70" style={{ width: `${w}%` }} />
                    ) : (
                      <div className="absolute right-1/2 top-0 h-full rounded-sm bg-rose-500/70" style={{ width: `${w}%` }} />
                    )}
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-[9px] text-zinc-400">{fmtUsd(s.netUsd, { compact: true, sign: true })}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyNote>{flow.loading ? 'loading…' : '—'}</EmptyNote>
        )}
      </Panel>
    </div>
  );
}
