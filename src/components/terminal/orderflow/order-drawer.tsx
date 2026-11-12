'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — the order-detail drawer: full forensic view of ONE print
// (aggressor, size vs displayed size, resting size at that second, the mid
// move after, iceberg candidacy, surrounding prints, verdict). Opened by
// clicking any bubble on the chart or any tape row.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { X, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { fmtPrice, fmtQty, fmtTime, fmtUsd, venueColor } from './use-orderflow';

interface PrintDetail {
  print: {
    id: string;
    venue: string;
    side: 'buy' | 'sell';
    price: number;
    quantity: number;
    quoteVolume: number;
    timestamp: number;
    ratio?: number;
    bookSize?: number;
  };
  venueName: string;
  nativeSymbol: string;
  surrounding: Array<{ id: string; venue: string; side: 'buy' | 'sell'; price: number; quantity: number; quoteVolume: number; timestamp: number }>;
  flowAfter: { t1s: number; t5s: number; t15s: number } | null;
  restingSizeAtPrice: number | null;
  iceberg: { traded: number; displayed: number; refills: number } | null;
  avgPrint: number;
  verdict: string;
}

export function OrderDrawer({ id, onClose, onPrintClick }: { id: string | null; onClose: () => void; onPrintClick: (id: string) => void }) {
  const [detail, setDetail] = useState<PrintDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setError(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setError(null);
    void fetch(`/api/orderflow/print?id=${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        return res.json() as Promise<PrintDetail>;
      })
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id) return null;
  const p = detail?.print;
  const buy = p?.side === 'buy';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-zinc-800 bg-[#07090d] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-zinc-800/80 bg-[#07090d]/95 px-3 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            {buy ? <ArrowUpRight className="h-4 w-4 text-emerald-400" /> : <ArrowDownRight className="h-4 w-4 text-rose-400" />}
            <span className="text-[11px] font-semibold text-zinc-100">order detail</span>
            {p && (
              <span className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] text-zinc-300 ring-1" style={{ borderColor: venueColor(p.venue) }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: venueColor(p.venue) }} />
                {p.venue}
              </span>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {!detail && !error && <p className="px-4 py-8 text-center text-[10px] text-zinc-600">loading forensic detail…</p>}
        {error && <p className="px-4 py-8 text-center text-[10px] text-rose-400">{error}</p>}

        {detail && p && (
          <div className="space-y-2.5 p-3">
            {/* headline */}
            <div className={`rounded-lg border p-2.5 ${buy ? 'border-emerald-500/25 bg-emerald-950/10' : 'border-rose-500/25 bg-rose-950/10'}`}>
              <div className="flex items-baseline justify-between">
                <span className={`font-mono text-[18px] font-bold ${buy ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {fmtPrice(p.price, detail.print.price > 5000 ? 1 : 2)}
                </span>
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${buy ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                  {buy ? 'aggressive buy' : 'aggressive sell'}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
                <div>
                  <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">size</p>
                  <p className="text-zinc-200">{fmtQty(p.quantity)}</p>
                </div>
                <div>
                  <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">notional</p>
                  <p className="text-zinc-200">{fmtUsd(p.quoteVolume)}</p>
                </div>
                <div>
                  <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">time utc</p>
                  <p className="text-zinc-200">{fmtTime(p.timestamp)}</p>
                </div>
              </div>
              <p className="mt-1 font-mono text-[7.5px] text-zinc-600">
                {detail.venueName} · {detail.nativeSymbol} · #{p.id} · {new Date(p.timestamp).toISOString().replace('T', ' ').slice(0, 23)}
              </p>
            </div>

            {/* size vs display */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-zinc-800/70 bg-zinc-900/40 p-2" title="size shown at this price on the venue's book when the print arrived">
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">displayed at level</p>
                <p className="font-mono text-[12px] text-zinc-200">{p.bookSize !== undefined ? fmtQty(p.bookSize) : '—'}</p>
                {p.bookSize !== undefined && (
                  <p className={`font-mono text-[8.5px] ${p.quantity > p.bookSize * 1.5 ? 'text-amber-400' : 'text-zinc-600'}`}>
                    {p.quantity > p.bookSize * 1.5 ? `⚠ ${(p.quantity / p.bookSize).toFixed(1)}× beyond display` : 'within display'}
                  </p>
                )}
              </div>
              <div className="rounded-md border border-zinc-800/70 bg-zinc-900/40 p-2" title="resting liquidity at this price on the heatmap snapshot nearest the print">
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">resting at price</p>
                <p className="font-mono text-[12px] text-zinc-200">{detail.restingSizeAtPrice !== null ? fmtQty(detail.restingSizeAtPrice) : '—'}</p>
                <p className="font-mono text-[8.5px] text-zinc-600">
                  {detail.restingSizeAtPrice !== null ? fmtUsd(detail.restingSizeAtPrice * p.price) : ''}
                </p>
              </div>
              <div className="rounded-md border border-zinc-800/70 bg-zinc-900/40 p-2" title="size ÷ session average print">
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">vs average</p>
                <p className="font-mono text-[12px] text-zinc-200">{p.ratio ? `${p.ratio.toFixed(1)}×` : '—'}</p>
                <p className="font-mono text-[8.5px] text-zinc-600">avg {fmtQty(detail.avgPrint)}</p>
              </div>
            </div>

            {/* flow after */}
            <div className="rounded-md border border-zinc-800/70 bg-zinc-900/40 p-2">
              <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">price path after the print</p>
              <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[11px]">
                {['t1s', 't5s', 't15s'].map((k, i) => {
                  const v = detail.flowAfter ? [detail.flowAfter.t1s, detail.flowAfter.t5s, detail.flowAfter.t15s][i] : null;
                  return (
                    <div key={k}>
                      <p className="text-[8px] text-zinc-600">{k}</p>
                      <p className={v !== null ? (v >= 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-600'}>
                        {v !== null ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}%` : '—'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* iceberg */}
            <div className={`rounded-md border p-2 ${detail.iceberg ? 'border-sky-500/40 bg-sky-950/15' : 'border-zinc-800/70 bg-zinc-900/40'}`}>
              <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">iceberg tracking at this level</p>
              {detail.iceberg ? (
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[11px] text-zinc-200">
                  <div>
                    <p className="text-[8px] text-zinc-600">traded</p>
                    <p>{fmtQty(detail.iceberg.traded)}</p>
                  </div>
                  <div>
                    <p className="text-[8px] text-zinc-600">first shown</p>
                    <p>{fmtQty(detail.iceberg.displayed)}</p>
                  </div>
                  <div>
                    <p className="text-[8px] text-zinc-600">refills</p>
                    <p className={detail.iceberg.refills > 0 ? 'text-sky-300' : 'text-zinc-500'}>{detail.iceberg.refills}</p>
                  </div>
                </div>
              ) : (
                <p className="mt-0.5 font-mono text-[9px] text-zinc-600">no live candidate at this level</p>
              )}
            </div>

            {/* verdict */}
            <div className="rounded-md border border-teal-500/25 bg-teal-950/10 p-2">
              <p className="text-[7.5px] uppercase tracking-wider text-teal-500/80">verdict</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-300">{detail.verdict}</p>
            </div>

            {/* surrounding prints */}
            <div>
              <p className="mb-1 text-[7.5px] uppercase tracking-wider text-zinc-600">surrounding prints ±5s</p>
              <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-800/70">
                {detail.surrounding.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onPrintClick(t.id)}
                    className={`flex w-full items-center justify-between gap-2 border-b border-zinc-900/70 px-2 py-1 text-left font-mono text-[9px] transition hover:bg-zinc-900/60 ${
                      t.id === p.id ? 'bg-zinc-800/60' : ''
                    }`}
                  >
                    <span className="text-zinc-600">{fmtTime(t.timestamp)}</span>
                    <span className="h-1 w-1 rounded-full" style={{ background: venueColor(t.venue) }} />
                    <span className={t.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{t.side === 'buy' ? 'B' : 'S'}</span>
                    <span className="text-zinc-300">{fmtPrice(t.price, t.price > 5000 ? 1 : 2)}</span>
                    <span className="text-zinc-400">{fmtQty(t.quantity)}</span>
                    <span className="text-zinc-500">{fmtUsd(t.quoteVolume)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
