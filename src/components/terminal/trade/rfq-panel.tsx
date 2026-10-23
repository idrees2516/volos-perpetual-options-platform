'use client';

// Strategy RFQ desk — request firm package quotes for the ENTIRE strategy
// (up to 25 legs) from the dealer network, watch quotes arrive/expire live,
// and execute atomically. The winning dealer's delta hedge route is shown
// on the fill receipt.

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { engine, type RfqSession } from '@/lib/api';
import { useStrategy } from '@/stores/strategy-store';
import { MAX_LEGS } from '@/lib/strategies';
import { fmtNum, fmtUsd } from '@/lib/format';
import { Handshake, Timer, Zap, Pencil, CheckCircle2, TrendingUp, TrendingDown } from 'lucide-react';

const QUOTE_STYLE: Record<string, string> = {
  pending: 'bg-amber-950/40 text-amber-300',
  live: 'bg-emerald-950/40 text-emerald-300 ring-1 ring-emerald-500/30',
  expired: 'bg-zinc-800/60 text-zinc-500',
  pulled: 'bg-rose-950/40 text-rose-300',
  filled: 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/40',
};

interface Props {
  notify: (kind: 'ok' | 'err', text: string) => void;
  onExecuted: () => void;
  onOpenBuilder: () => void;
}

export function RfqPanel({ notify, onExecuted, onOpenBuilder }: Props) {
  const { legs, underlying, size, strategyName, setSize } = useStrategy();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [session, setSession] = useState<RfqSession | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // wall clock for countdowns
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(iv);
  }, []);

  // poll the active quoting session
  useEffect(() => {
    if (!session || session.state !== 'quoting') {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => {
      engine
        .rfqGet(session.id)
        .then(setSession)
        .catch(() => {});
    }, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [session?.id, session?.state]);

  const create = () => {
    if (!legs.length) {
      notify('err', 'Add legs in the builder first (or load a strategy from the library)');
      return;
    }
    setBusy(true);
    engine
      .rfqCreate({ underlying, legs, side, size })
      .then((s) => {
        setSession(s);
        notify('ok', `RFQ #${s.id} broadcast to 6 dealers — ${legs.length} legs, ${underlying}`);
      })
      .catch((e) => notify('err', String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const execute = (dealer: string) => {
    if (!session) return;
    setBusy(true);
    engine
      .rfqExecute(session.id, dealer)
      .then((r) => {
        notify(
          'ok',
          `Executed with ${r.execution.dealer} @ ${fmtUsd(r.execution.price)} — hedged across ${r.execution.hedge.length} venues @ ${fmtNum(r.execution.hedgeVwap, 1)}`,
        );
        onExecuted();
        return engine.rfqGet(session.id);
      })
      .then((s) => s && setSession(s))
      .catch((e) => notify('err', String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const cancel = () => {
    if (!session) return;
    engine
      .rfqCancel(session.id)
      .then(() => {
        setSession((s) => (s ? { ...s, state: 'cancelled' } : s));
        notify('ok', `RFQ #${session.id} cancelled`);
      })
      .catch((e) => notify('err', String((e as Error).message ?? e)));
  };

  const liveQuotes = (session?.quotes ?? []).filter((q) => q.status === 'live');
  const best = liveQuotes.reduce<typeof liveQuotes[number] | null>((b, q) => {
    if (!b) return q;
    return session?.side === 'buy' ? (q.price < b.price ? q : b) : q.price > b.price ? q : b;
  }, null);
  const ttl = session ? Math.max(0, Math.round((session.expiresMs - now) / 1000)) : 0;
  const sessionLive = session?.state === 'quoting';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          <Handshake className="h-3.5 w-3.5 text-teal-400" /> Strategy RFQ
        </p>
        {sessionLive && (
          <span className="flex items-center gap-1 rounded bg-amber-950/40 px-1.5 py-0.5 font-mono text-[9px] text-amber-300">
            <Timer className="h-3 w-3" /> {ttl}s
          </span>
        )}
      </div>

      {/* Strategy summary + link to builder (legs creation) */}
      <button
        onClick={onOpenBuilder}
        className="mb-2 flex w-full items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-left transition hover:border-teal-500/40"
      >
        <Pencil className="h-3.5 w-3.5 shrink-0 text-teal-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-zinc-200">{strategyName}</p>
          <p className="text-[9px] text-zinc-500">
            {underlying} · {legs.length}/{MAX_LEGS} legs · size{' '}
            <input
              onClick={(e) => e.stopPropagation()}
              type="number"
              min={0.001}
              step={0.5}
              value={size}
              onChange={(e) => setSize(parseFloat(e.target.value) || 1)}
              className="w-12 bg-transparent text-right font-mono text-[9px] text-teal-300 outline-none"
            />
            × · click to edit legs
          </p>
        </div>
        <span className="shrink-0 font-mono text-[9px] text-zinc-500">{legs.length ? 'ready' : 'empty'}</span>
      </button>

      {/* Side + create */}
      {!sessionLive && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => setSide('buy')}
              className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-[10px] font-bold uppercase transition ${
                side === 'buy'
                  ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/50'
                  : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <TrendingUp className="h-3 w-3" /> Buy package
            </button>
            <button
              onClick={() => setSide('sell')}
              className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-[10px] font-bold uppercase transition ${
                side === 'sell'
                  ? 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/50'
                  : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <TrendingDown className="h-3 w-3" /> Sell package
            </button>
          </div>
          <Button
            onClick={create}
            disabled={busy || !legs.length}
            className="mt-2 h-8 w-full bg-teal-500 text-[11px] font-bold text-zinc-950 hover:bg-teal-400"
          >
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            {busy ? 'Broadcasting…' : `Request quotes — ${legs.length} legs`}
          </Button>
        </>
      )}

      {/* Quotes */}
      {session && (
        <div className="mt-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-zinc-600">
            <span>
              RFQ #{session.id} · {session.state}
            </span>
            <span>theo {fmtUsd(session.theo)}</span>
          </div>
          {session.quotes
            .filter((q) => ['live', 'filled', 'pending', 'pulled'].includes(q.status))
            .slice(-8)
            .map((q, i) => {
              const secsLeft = Math.max(0, Math.round((q.validUntilMs - now) / 1000));
              const isBest = best?.seq === q.seq && q.status === 'live';
              return (
                <div
                  key={`${q.dealer}-${q.seq}-${i}`}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                    isBest ? 'border-teal-500/50 bg-teal-950/20' : 'border-zinc-800 bg-zinc-950/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-medium text-zinc-200">
                      {q.dealer}
                      <span className="ml-1.5 text-[8px] text-zinc-500">{q.venue}</span>
                    </p>
                    <p className="font-mono text-[9px] text-zinc-500">
                      edge {q.edgeBps.toFixed(1)}bp · skew {q.inventorySkewBps.toFixed(1)}bp · fee {q.feeBps.toFixed(1)}bp
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`font-mono text-[11px] font-semibold ${session.side === 'buy' ? 'text-rose-300' : 'text-emerald-300'}`}>
                      {fmtUsd(q.price)}
                    </p>
                    <p className="font-mono text-[8px] text-zinc-600">
                      {q.status === 'live' ? `${secsLeft}s` : q.status}
                    </p>
                  </div>
                  {q.status === 'live' && sessionLive && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => execute(q.dealer)}
                      className="h-6 shrink-0 bg-teal-500 px-2 text-[9px] font-bold text-zinc-950 hover:bg-teal-400"
                    >
                      Take
                    </Button>
                  )}
                  {q.status === 'filled' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-teal-400" />}
                </div>
              );
            })}
          {sessionLive && (
            <button
              onClick={cancel}
              className="w-full rounded-md border border-zinc-800 py-1 text-[9px] text-zinc-500 transition hover:border-rose-900/60 hover:text-rose-300"
            >
              Cancel RFQ
            </button>
          )}

          {/* Execution receipt */}
          {session.execution && (
            <div className="rounded-md border border-teal-500/40 bg-teal-950/20 p-2.5">
              <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-teal-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> Filled by {session.execution.dealer} @ {fmtUsd(session.execution.price)}
              </p>
              <p className="font-mono text-[9px] text-zinc-400">
                fee {fmtUsd(session.execution.fee)} · dealer hedge vwap {fmtNum(session.execution.hedgeVwap, 1)}
              </p>
              <div className="mt-1.5 space-y-0.5">
                {session.execution.hedge.map((h, i) => (
                  <div key={i} className="flex items-center justify-between font-mono text-[9px]">
                    <span className="text-zinc-400">{h.ownClob ? '↳ Volos CLOB' : `↳ ${h.venue}`}</span>
                    <span className="text-zinc-500">
                      {fmtNum(h.qty, 3)} @ {fmtNum(h.price, 1)} · {h.latencyMs.toFixed(0)}ms
                    </span>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-6 w-full border-zinc-700 bg-zinc-900 text-[9px] text-zinc-300"
                onClick={() => setSession(null)}
              >
                New RFQ
              </Button>
            </div>
          )}

          {session.state === 'expired' && (
            <Button size="sm" variant="outline" className="h-6 w-full border-zinc-700 text-[9px]" onClick={() => setSession(null)}>
              New RFQ
            </Button>
          )}
        </div>
      )}

      {!session && (
        <p className="mt-2 rounded-md border border-dashed border-zinc-800 p-2.5 text-[9px] leading-relaxed text-zinc-600">
          Request firm quotes for the whole strategy — every leg settles atomically or nothing does.
          Dealers quote from {fmtUsd(0).slice(0, 0)}Volos CLOB, Derive, Paradex and Paradigm liquidity, and the winner
          delta-hedges across venues via the smart order router.
        </p>
      )}
    </div>
  );
}
