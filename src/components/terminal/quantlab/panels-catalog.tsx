'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-catalog — OUR OWN API catalog: the native /api/quant
// registry with a live try-it console and per-source engine health.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { useQuant } from './use-quant';
import { DataTable, EmptyNote, ErrNote, LiveDot, Panel, Pill } from './quant-viz';

interface EndpointSpec {
  method: string;
  path: string;
  group: string;
  summary: string;
  params: { name: string; desc: string; example?: string }[];
  views?: string[];
}
interface StatusData {
  engine: string;
  status: string;
  sources: { name: string; ok: boolean; ageMs: number | null; instruments?: number }[];
  tape: { symbol: string; running: boolean; backfilled: boolean; printsInMemory: number; lastPollTs: number | null; pollMs: number }[];
  persistence: { driver: string; models: string[] };
  liveNotes: string;
}

export function CatalogPanel() {
  const reg = useQuant<{ engine: string; endpoints: EndpointSpec[]; count: number; note: string }>('/catalog', { view: 'registry' }, { pollMs: 60000 });
  const status = useQuant<StatusData>('/catalog', { view: 'status' }, { pollMs: 15000 });
  const [open, setOpen] = useState<string | null>(null);
  const [tryUrl, setTryUrl] = useState<string>('');
  const [tryResult, setTryResult] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  const endpoints = reg.data?.endpoints ?? [];
  const groups = [...new Set(endpoints.map((e) => e.group))];

  const runTry = async () => {
    if (!tryUrl) return;
    setTrying(true);
    setTryResult(null);
    try {
      const res = await fetch(tryUrl.startsWith('/api/') ? tryUrl : `/api/quant${tryUrl.startsWith('/') ? tryUrl : `/${tryUrl}`}`, { cache: 'no-store' });
      const json = await res.json();
      setTryResult(JSON.stringify(json, null, 2).slice(0, 4000));
    } catch (e) {
      setTryResult(String(e));
    } finally {
      setTrying(false);
    }
  };

  return (
    <div className="space-y-2">
      <Panel
        title="VolQuant Engine · Service Status"
        sub={status.data?.liveNotes}
        right={<LiveDot ok={status.data?.status === 'ok'} label={status.data?.engine ?? 'volquant'} />}
      >
        <ErrNote error={status.error} />
        {status.data ? (
          <>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {status.data.sources.map((s) => (
                <div key={s.name} className="flex items-center justify-between rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
                  <span className="font-mono text-[9px] text-zinc-400">{s.name}</span>
                  <span className={`font-mono text-[9px] ${s.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{s.ok ? 'ok' : 'down'}{s.ageMs != null ? ` ${Math.round(s.ageMs / 1000)}s` : ''}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[8.5px] text-zinc-500">
              {status.data.tape.map((t) => (
                <span key={t.symbol}>
                  tape {t.symbol}: {t.printsInMemory} prints in memory · poll {t.pollMs / 1000}s {t.backfilled ? '· backfilled' : '· backfilling…'}
                </span>
              ))}
              <span>persistence: {status.data.persistence.driver} ({status.data.persistence.models.join(', ')})</span>
            </div>
          </>
        ) : (
          <EmptyNote>{status.loading ? 'checking sources…' : '—'}</EmptyNote>
        )}
      </Panel>

      <Panel title="Try-It Console" sub="hit any native endpoint live">
        <div className="flex flex-wrap gap-1.5">
          <input
            value={tryUrl}
            onChange={(e) => setTryUrl(e.target.value)}
            placeholder="/api/quant/brief?symbol=BTC"
            className="min-w-[240px] flex-1 rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1.5 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-700"
          />
          <button
            onClick={() => void runTry()}
            className="rounded-md bg-teal-600/80 px-3 py-1.5 text-[10px] font-semibold text-zinc-950 transition hover:bg-teal-500"
          >
            {trying ? '…' : 'run'}
          </button>
        </div>
        {tryResult && (
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/80 p-2 font-mono text-[8.5px] leading-relaxed text-zinc-400">{tryResult}</pre>
        )}
      </Panel>

      {reg.data && (
        <Panel title="Native Endpoint Registry" sub={`${reg.data.count} endpoints · every one computes live — no vendor, no demos`} right={<Pill tone="teal">{reg.data.engine}</Pill>}>
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <p className="mb-1 text-[8px] font-bold uppercase tracking-[0.16em] text-teal-500">{g}</p>
              <div className="space-y-0.5">
                {endpoints.filter((e) => e.group === g).map((e) => (
                  <div key={e.path} className="rounded-md border border-zinc-900 bg-zinc-950/40">
                    <button
                      onClick={() => setOpen(open === e.path ? null : e.path)}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-900/50"
                    >
                      <span className="rounded bg-emerald-950/60 px-1 py-0.5 font-mono text-[7.5px] font-bold text-emerald-400 ring-1 ring-emerald-800/50">{e.method}</span>
                      <span className="font-mono text-[9.5px] text-zinc-200">{e.path}</span>
                      <span className="ml-auto truncate text-[8.5px] text-zinc-600">{e.summary}</span>
                    </button>
                    {open === e.path && (
                      <div className="border-t border-zinc-900 px-2.5 py-1.5">
                        <p className="text-[9px] text-zinc-400">{e.summary}</p>
                        <div className="mt-1 space-y-0.5">
                          {e.params.map((p) => (
                            <p key={p.name} className="font-mono text-[8.5px] text-zinc-500">
                              <span className="text-teal-400">{p.name}</span> — {p.desc}
                              {p.example ? ` (e.g. ${p.example})` : ''}
                            </p>
                          ))}
                        </div>
                        {e.views && <p className="mt-1 font-mono text-[8px] text-zinc-600">views: {e.views.join(' · ')}</p>}
                        <button
                          onClick={() => {
                            setTryUrl(`/api/quant${e.path.replace('/api/quant', '')}${e.params.find((p) => p.name === 'symbol')?.example ? `?symbol=${e.params.find((p) => p.name === 'symbol')?.example}` : ''}`);
                          }}
                          className="mt-1.5 rounded border border-teal-800/60 px-2 py-0.5 text-[8.5px] font-medium text-teal-300 transition hover:bg-teal-950/40"
                        >
                          load in try-it →
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[8.5px] leading-relaxed text-zinc-600">{reg.data.note}</p>
        </Panel>
      )}
      <ErrNote error={reg.error} />
    </div>
  );
}
