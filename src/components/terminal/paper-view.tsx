'use client';

// Paper Desk — strategy paper-trading on REAL exchange prices.
// Virtual $100k USDC account; every order fills at the live best-bid/ask
// across Deribit · Bybit · OKX · Aevo · Paradex · Derive v3 (auto-routed),
// with per-venue taker fees, short margin, live marks, and P&L.
// Live exchange connectivity for all 9 venues (incl. Binance · Hyperliquid ·
// Lighter) is shown alongside the order ticket.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStrategy } from '@/stores/strategy-store';
import { fmtNum, fmtUsd } from '@/lib/format';
import { LiveExchangeStatus } from './trade/venue-panel';
import {
  Wallet, RefreshCw, Loader2, TrendingUp, TrendingDown, RotateCcw,
  FlaskConical, Zap, X, ArrowUpRight, ArrowDownRight, Radio,
} from 'lucide-react';

interface PaperPosition {
  id: string;
  venue: string;
  asset: string;
  expiry: string;
  strike: number;
  kind: 'call' | 'put';
  side: 'long' | 'short';
  qty: number;
  entryPrice: number;
  markPrice: number;
  openedAt: number;
  feesPaid: number;
  marginHeld: number;
  strategyTag?: string;
  unrealized: number;
  pnlPct: number;
  hasLiveQuote: boolean;
}

interface PaperFill {
  id: string;
  ts: number;
  venue: string;
  asset: string;
  expiry: string;
  strike: number;
  kind: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  spotAtFill: number;
  strategyTag?: string;
}

interface PaperOrder {
  id: string;
  createdAt: number;
  venue: string;
  asset: string;
  expiry: string;
  strike: number;
  kind: string;
  side: 'buy' | 'sell';
  qty: number;
  limitPrice: number;
}

interface AccountView {
  startingCash: number;
  cash: number;
  marginHeld: number;
  buyingPower: number;
  equity: number;
  unrealized: number;
  realizedTotal: number;
  feesTotal: number;
  wins: number;
  losses: number;
  winRate: number;
  positions: PaperPosition[];
  openOrders: PaperOrder[];
  fills: PaperFill[];
  equityCurve: { t: number; equity: number }[];
  updatedAt: number;
}

interface PreviewQuote {
  venue: string;
  bid: number | null;
  ask: number | null;
  mid: number;
  iv: number;
  expiry: string;
  daysOut: number;
  spot: number;
  feeBps: number;
  quoteSource: string;
}

interface ChainInfo {
  expiries: { label: string; daysOut: number }[];
  rows: { strike: number }[];
}

const VENUES = ['auto', 'deribit', 'bybit', 'okx', 'aevo', 'paradex', 'derive'] as const;
const VENUE_LABEL: Record<string, string> = {
  auto: 'Auto-route (best price)',
  deribit: 'Deribit',
  bybit: 'Bybit',
  okx: 'OKX',
  aevo: 'Aevo',
  paradex: 'Paradex',
  derive: 'Derive v3',
};

export function PaperView() {
  const { legs: builderLegs, underlying, strategyName, size } = useStrategy();
  const [account, setAccount] = useState<AccountView | null>(null);
  const [chain, setChain] = useState<ChainInfo | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ticket state
  const [tVenue, setTVenue] = useState<string>('auto');
  const [tAsset, setTAsset] = useState<'BTC' | 'ETH' | 'SOL'>('BTC');
  const [tExpiry, setTExpiry] = useState<string>('');
  const [tStrike, setTStrike] = useState<string>('');
  const [tKind, setTKind] = useState<'call' | 'put'>('call');
  const [tSide, setTSide] = useState<'buy' | 'sell'>('buy');
  const [tQty, setTQty] = useState('0.1');
  const [tType, setTType] = useState<'market' | 'limit'>('market');
  const [tLimit, setTLimit] = useState('');
  const [preview, setPreview] = useState<PreviewQuote | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [deploying, setDeploying] = useState(false);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setFlash({ kind, text });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 5000);
  }, []);

  const refresh = useCallback(() => {
    fetch('/api/paper')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setAccount(j.account))
      .catch(() => {});
  }, []);

  // account poll
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  // chain calendar for the ticket
  useEffect(() => {
    let alive = true;
    fetch(`/api/chain?asset=${tAsset}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j) {
          setChain({ expiries: j.expiries ?? [], rows: j.rows ?? [] });
          const first = (j.expiries ?? []).find((e: { label: string; daysOut: number }) => e.daysOut > 1.5);
          setTExpiry((prev) => prev || first?.label || (j.expiries?.[0]?.label ?? ''));
          if (!tStrike) {
            const atm = (j.rows ?? []).find((r: { isAtm?: boolean }) => r.isAtm);
            if (atm) setTStrike(String(atm.strike));
          }
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tAsset]);

  // live preview of the ticket quote
  const strikeNum = Number(tStrike);
  useEffect(() => {
    if (!(strikeNum > 0)) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewing(true);
    const load = () => {
      fetch('/api/paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          asset: tAsset,
          venue: tVenue,
          strike: strikeNum,
          kind: tKind,
          side: tSide,
          expiry: tExpiry || undefined,
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (alive) setPreview(j?.quote ?? null);
        })
        .catch(() => {})
        .finally(() => alive && setPreviewing(false));
    };
    load();
    const iv = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [tVenue, tAsset, tExpiry, strikeNum, tKind, tSide]);

  const placeOrder = () => {
    if (!(strikeNum > 0) || !(Number(tQty) > 0)) {
      notify('err', 'Pick a strike and quantity first');
      return;
    }
    setPlacing(true);
    fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'order',
        asset: tAsset,
        venue: tVenue,
        expiry: tExpiry || undefined,
        strike: strikeNum,
        kind: tKind,
        side: tSide,
        qty: Number(tQty),
        type: tType,
        limitPrice: tType === 'limit' ? Number(tLimit) : undefined,
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          const f = j.fill;
          if (f) notify('ok', `Filled ${f.side} ${f.qty} ${f.asset} ${f.expiry} ${f.strike} ${f.kind} @ $${fmtNum(f.price, 2)} on ${VENUE_LABEL[f.venue] ?? f.venue} (fee $${fmtNum(f.fee, 2)})`);
          else if (j.rested) notify('ok', `Limit order resting: ${j.rested.side} ${j.rested.qty} @ $${fmtNum(j.rested.limitPrice, 2)}`);
        } else notify('err', j.error ?? 'order rejected');
      })
      .catch((e) => notify('err', String(e)))
      .finally(() => {
        setPlacing(false);
        refresh();
      });
  };

  const closePosition = (id: string) => {
    fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close', positionId: id }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) notify('ok', `Closed at $${fmtNum(j.fill.price, 2)} on ${VENUE_LABEL[j.fill.venue] ?? j.fill.venue}`);
        else notify('err', j.error ?? 'close failed');
      })
      .catch((e) => notify('err', String(e)))
      .finally(refresh);
  };

  const cancelOrder = (id: string) => {
    fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', orderId: id }),
    })
      .then((r) => r.json())
      .then((j) => (j.ok ? notify('ok', 'Order cancelled') : notify('err', j.error ?? 'cancel failed')))
      .finally(refresh);
  };

  const resetAccount = () => {
    fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    })
      .then((r) => r.json())
      .then((j) => j.ok && notify('ok', 'Paper account reset to $100,000'))
      .finally(refresh);
  };

  // deploy the current builder strategy as a paper package
  const deployBuilder = () => {
    const dated = builderLegs.filter((l) => (l.kind === 'call' || l.kind === 'put') && l.strike && l.qty > 0);
    if (dated.length === 0) {
      notify('err', 'Builder has no dated option legs — add legs in the Strategy Builder first');
      return;
    }
    setDeploying(true);
    fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'strategy',
        name: strategyName || 'Builder Strategy',
        asset: underlying,
        venue: 'auto',
        sizeMultiplier: Math.max(1, Math.round(size)),
        legs: dated.map((l) => ({
          kind: l.kind,
          side: l.side,
          qty: l.qty,
          strike: l.strike,
          expiryDays: l.expiryDays ?? 30,
        })),
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          const legsTxt = (j.legs ?? []).map((l: { leg: string; venue: string; price: number }) => `${l.leg} @ ${fmtNum(l.price, 1)} (${l.venue})`).join(' · ');
          notify('ok', `Paper-deployed ${j.legs?.length ?? 0} legs: ${legsTxt}`);
        } else notify('err', j.error ?? 'deploy failed');
      })
      .catch((e) => notify('err', String(e)))
      .finally(() => {
        setDeploying(false);
        refresh();
      });
  };

  const pnlToday = account ? account.equity - account.startingCash : 0;
  const curve = account?.equityCurve ?? [];
  const minMax = useMemo(() => {
    if (curve.length < 2) return null;
    const vals = curve.map((c) => c.equity);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [curve]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      {/* Account header */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-teal-400" />
          <div>
            <p className="text-[9px] uppercase tracking-wider text-zinc-500">Paper equity</p>
            <p className="font-mono text-sm font-bold text-zinc-100">{account ? fmtUsd(account.equity) : '—'}</p>
          </div>
        </div>
        <Stat label="Cash" value={account ? fmtUsd(account.cash) : '—'} />
        <Stat label="Buying power" value={account ? fmtUsd(account.buyingPower) : '—'} />
        <Stat label="Margin held" value={account ? fmtUsd(account.marginHeld) : '—'} />
        <Stat label="Unrealized" value={account ? fmtUsd(account.unrealized) : '—'} tone={(account?.unrealized ?? 0) >= 0 ? 'pos' : 'neg'} />
        <Stat label="Realized" value={account ? fmtUsd(account.realizedTotal) : '—'} tone={(account?.realizedTotal ?? 0) >= 0 ? 'pos' : 'neg'} />
        <Stat label="Fees" value={account ? fmtUsd(account.feesTotal) : '—'} />
        <Stat
          label="Win rate"
          value={account ? `${account.winRate}% (${account.wins}W/${account.losses}L)` : '—'}
        />
        <Stat label="Net P&L" value={fmtUsd(pnlToday)} tone={pnlToday >= 0 ? 'pos' : 'neg'} />
        {minMax && <EquitySpark curve={curve} min={minMax.min} max={minMax.max} />}
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
            <Radio className="h-3 w-3 text-teal-400" /> fills at real venue BBO
          </span>
          <Button size="sm" variant="outline" className="h-7 border-zinc-700 bg-zinc-900 text-[9px] hover:bg-zinc-800" onClick={resetAccount}>
            <RotateCcw className="mr-1 h-3 w-3" /> Reset
          </Button>
        </div>
      </div>

      {flash && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            flash.kind === 'ok'
              ? 'border-teal-500/40 bg-teal-950/40 text-teal-200'
              : 'border-rose-500/40 bg-rose-950/40 text-rose-200'
          }`}
        >
          {flash.kind === 'ok' ? <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 break-words">{flash.text}</span>
        </div>
      )}

      <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[380px_minmax(0,1fr)]">
        {/* Order ticket + live exchange connectivity */}
        <div className="flex min-h-0 flex-col gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            <FlaskConical className="h-3.5 w-3.5 text-teal-400" /> Paper order ticket
          </p>
          <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Venue</label>
          <select
            value={tVenue}
            onChange={(e) => setTVenue(e.target.value)}
            className="mb-2 h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-[11px] text-zinc-200 outline-none focus:border-teal-500/50"
          >
            {VENUES.map((v) => (
              <option key={v} value={v}>
                {VENUE_LABEL[v]}
              </option>
            ))}
          </select>

          <div className="mb-2 grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Asset</label>
              <div className="flex h-8 rounded border border-zinc-800 bg-zinc-950 p-0.5">
                {(['BTC', 'ETH', 'SOL'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setTAsset(a)}
                    className={`flex-1 rounded text-[10px] font-bold transition ${
                      tAsset === a ? 'bg-teal-500/90 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Type</label>
              <div className="flex h-8 rounded border border-zinc-800 bg-zinc-950 p-0.5">
                {(['call', 'put'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setTKind(k)}
                    className={`flex-1 rounded text-[10px] font-bold uppercase transition ${
                      tKind === k ? 'bg-sky-500/90 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Side</label>
              <div className="flex h-8 rounded border border-zinc-800 bg-zinc-950 p-0.5">
                {(['buy', 'sell'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setTSide(s)}
                    className={`flex-1 rounded text-[10px] font-bold uppercase transition ${
                      tSide === s
                        ? s === 'buy'
                          ? 'bg-emerald-600/90 text-white'
                          : 'bg-rose-600/90 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Expiry</label>
              <select
                value={tExpiry}
                onChange={(e) => setTExpiry(e.target.value)}
                className="h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-[11px] text-zinc-200 outline-none focus:border-teal-500/50"
              >
                {(chain?.expiries ?? []).map((e) => (
                  <option key={e.label} value={e.label}>
                    {e.label} ({e.daysOut.toFixed(0)}d)
                  </option>
                ))}
                {!chain?.expiries?.length && <option value="">loading…</option>}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Strike</label>
              <input
                type="number"
                value={tStrike}
                onChange={(e) => setTStrike(e.target.value)}
                list="paper-strikes"
                className="h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-right font-mono text-[11px] text-zinc-200 outline-none focus:border-teal-500/50"
              />
              <datalist id="paper-strikes">
                {(chain?.rows ?? []).map((r) => (
                  <option key={r.strike} value={r.strike} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Qty ({tAsset})</label>
              <input
                type="number"
                step="any"
                min={0}
                value={tQty}
                onChange={(e) => setTQty(e.target.value)}
                className="h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-right font-mono text-[11px] text-zinc-200 outline-none focus:border-teal-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Order</label>
              <div className="flex h-8 rounded border border-zinc-800 bg-zinc-950 p-0.5">
                {(['market', 'limit'] as const).map((tp) => (
                  <button
                    key={tp}
                    onClick={() => setTType(tp)}
                    className={`flex-1 rounded text-[10px] font-bold uppercase transition ${
                      tType === tp ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {tp}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {tType === 'limit' && (
            <div className="mb-2">
              <label className="mb-1 block text-[9px] uppercase tracking-wider text-zinc-500">Limit price (USD)</label>
              <input
                type="number"
                step="any"
                min={0}
                value={tLimit}
                onChange={(e) => setTLimit(e.target.value)}
                placeholder={preview ? String(tSide === 'buy' ? preview.ask ?? preview.mid : preview.bid ?? preview.mid) : ''}
                className="h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-right font-mono text-[11px] text-zinc-200 outline-none focus:border-teal-500/50"
              />
            </div>
          )}

          {/* live preview */}
          <div className="mb-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
            {previewing && !preview && <p className="text-[10px] text-zinc-500">Resolving quote across venues…</p>}
            {preview && (
              <div className="space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span className="text-zinc-500">
                    {VENUE_LABEL[preview.venue] ?? preview.venue}
                    {tVenue === 'auto' ? ' · best route' : ''}
                  </span>
                  <span className="text-zinc-400">
                    {preview.expiry} · {preview.daysOut.toFixed(1)}d · IV {preview.iv.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center justify-between font-mono text-xs tabular-nums">
                  <span className="text-emerald-400">{preview.bid != null ? fmtNum(preview.bid, 2) : '—'} bid</span>
                  <span className="text-zinc-500">spot {fmtNum(preview.spot, 0)}</span>
                  <span className="text-rose-400">{preview.ask != null ? fmtNum(preview.ask, 2) : '—'} ask</span>
                </div>
                <p className="text-[8.5px] text-zinc-600">
                  Market {tSide === 'buy' ? 'buy fills at the ask' : 'sell fills at the bid'} · taker fee {preview.feeBps} bps of notional ·{' '}
                  {preview.quoteSource === 'live' ? 'native venue quotes' : 'IV-derived quotes'}
                </p>
              </div>
            )}
            {!previewing && !preview && <p className="text-[10px] text-zinc-600">Enter a strike to preview the live quote.</p>}
          </div>

          <Button
            onClick={placeOrder}
            disabled={placing}
            className={`h-9 w-full text-[11px] font-bold ${
              tSide === 'buy' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'
            } text-white`}
          >
            {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : `${tSide.toUpperCase()} ${tQty} ${tAsset} ${tKind.toUpperCase()} @ ${tType}`}
          </Button>

          {/* deploy builder strategy */}
          <div className="mt-3 rounded-md border border-dashed border-teal-700/50 bg-teal-950/20 p-2">
            <p className="mb-1.5 text-[9px] uppercase tracking-wider text-teal-300/80">Strategy paper-testing</p>
            <p className="mb-2 text-[9.5px] leading-snug text-zinc-500">
              Deploy the current builder strategy ({builderLegs.filter((l) => l.kind === 'call' || l.kind === 'put').length} dated legs ·{' '}
              {underlying} · ×{Math.max(1, Math.round(size))}) as one paper package at real cross-venue quotes.
            </p>
            <Button
              size="sm"
              onClick={deployBuilder}
              disabled={deploying}
              className="h-7 w-full bg-teal-500/90 text-[10px] font-bold text-zinc-950 hover:bg-teal-400"
            >
              {deploying ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="mr-1 h-3 w-3" />}
              Paper-deploy “{strategyName}”
            </Button>
          </div>
        </div>

        {/* Connected exchanges — all 9 venues incl. Binance · Hyperliquid · Lighter */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <LiveExchangeStatus asset={underlying} />
        </div>
        </div>

        {/* Positions / orders / fills */}
        <div className="flex min-h-0 flex-col gap-3">
          {/* positions */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              <TrendingUp className="h-3.5 w-3.5 text-teal-400" /> Positions
              <span className="ml-auto font-mono text-[9px] text-zinc-500">{account?.positions.length ?? 0} open</span>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-zinc-800 text-[8.5px] uppercase tracking-wider text-zinc-500">
                    <th className="py-1.5 pr-2">Venue</th>
                    <th className="py-1.5 pr-2">Instrument</th>
                    <th className="py-1.5 pr-2">Side</th>
                    <th className="py-1.5 pr-2 text-right">Qty</th>
                    <th className="py-1.5 pr-2 text-right">Entry</th>
                    <th className="py-1.5 pr-2 text-right">Mark</th>
                    <th className="py-1.5 pr-2 text-right">uP&L</th>
                    <th className="py-1.5 pr-2 text-right">%</th>
                    <th className="py-1.5 pr-2">Strategy</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {(account?.positions ?? []).map((p) => (
                    <tr key={p.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/60">
                      <td className="py-1.5 pr-2">
                        <span className="rounded bg-zinc-800/80 px-1 text-[8.5px] text-zinc-300">{VENUE_LABEL[p.venue] ?? p.venue}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-zinc-200">
                        {p.asset} {p.expiry} {fmtNum(p.strike, 0)} {p.kind.toUpperCase()}
                      </td>
                      <td className={`py-1.5 pr-2 font-bold ${p.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {p.side === 'long' ? <ArrowUpRight className="inline h-3 w-3" /> : <ArrowDownRight className="inline h-3 w-3" />}
                        {p.side}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-zinc-300">{fmtNum(p.qty, 3)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-300">{fmtNum(p.entryPrice, 2)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-300">{fmtNum(p.markPrice, 2)}</td>
                      <td className={`py-1.5 pr-2 text-right font-semibold ${p.unrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {fmtUsd(p.unrealized)}
                      </td>
                      <td className={`py-1.5 pr-2 text-right ${p.pnlPct >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                        {p.pnlPct >= 0 ? '+' : ''}
                        {p.pnlPct}%
                      </td>
                      <td className="max-w-[120px] truncate py-1.5 pr-2 text-[8.5px] text-violet-300/70" title={p.strategyTag}>
                        {p.strategyTag ?? '—'}
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          onClick={() => closePosition(p.id)}
                          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase text-zinc-300 transition hover:border-rose-600/50 hover:text-rose-300"
                        >
                          close
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(account?.positions.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={10} className="py-4 text-center text-[10px] text-zinc-600">
                        No open paper positions — place an order or deploy a strategy package.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* resting limit orders */}
          {(account?.openOrders.length ?? 0) > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Resting limit orders</p>
              <div className="space-y-1">
                {account?.openOrders.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5 font-mono text-[10px]">
                    <span className={o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{o.side.toUpperCase()}</span>
                    <span className="text-zinc-300">
                      {o.qty} {o.asset} {o.expiry} {o.strike} {o.kind}
                    </span>
                    <span className="text-zinc-500">@ {fmtNum(o.limitPrice, 2)} limit</span>
                    <span className="rounded bg-zinc-800/80 px-1 text-[8.5px] text-zinc-400">{VENUE_LABEL[o.venue] ?? o.venue}</span>
                    <button
                      onClick={() => cancelOrder(o.id)}
                      className="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[8.5px] uppercase text-zinc-400 hover:border-rose-600/50 hover:text-rose-300"
                    >
                      cancel
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* fills */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              <RefreshCw className="h-3.5 w-3.5 text-sky-400" /> Fill history
              <span className="ml-auto font-mono text-[9px] text-zinc-500">{account?.fills.length ?? 0} recent</span>
            </p>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full min-w-[600px] text-left font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-zinc-800 text-[8.5px] uppercase tracking-wider text-zinc-500">
                    <th className="py-1.5 pr-2">Time</th>
                    <th className="py-1.5 pr-2">Action</th>
                    <th className="py-1.5 pr-2">Instrument</th>
                    <th className="py-1.5 pr-2 text-right">Qty</th>
                    <th className="py-1.5 pr-2 text-right">Price</th>
                    <th className="py-1.5 pr-2 text-right">Fee</th>
                    <th className="py-1.5 pr-2">Venue</th>
                    <th className="py-1.5">Strategy</th>
                  </tr>
                </thead>
                <tbody>
                  {(account?.fills ?? []).map((f) => (
                    <tr key={f.id} className="border-b border-zinc-800/50">
                      <td className="py-1.5 pr-2 text-zinc-500">{new Date(f.ts).toLocaleTimeString()}</td>
                      <td className={`py-1.5 pr-2 font-bold ${f.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{f.side}</td>
                      <td className="py-1.5 pr-2 text-zinc-300">
                        {f.asset} {f.expiry} {f.strike} {f.kind.toUpperCase()}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-zinc-300">{fmtNum(f.qty, 3)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-200">{fmtNum(f.price, 2)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-500">${fmtNum(f.fee, 2)}</td>
                      <td className="py-1.5 pr-2">
                        <span className="rounded bg-zinc-800/80 px-1 text-[8.5px] text-zinc-300">{VENUE_LABEL[f.venue] ?? f.venue}</span>
                      </td>
                      <td className="max-w-[110px] truncate py-1.5 text-[8.5px] text-violet-300/70">{f.strategyTag ?? '—'}</td>
                    </tr>
                  ))}
                  {(account?.fills.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={8} className="py-3 text-center text-[10px] text-zinc-600">
                        No fills yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`font-mono text-xs font-semibold ${
          tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-200'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function EquitySpark({ curve, min, max }: { curve: { t: number; equity: number }[]; min: number; max: number }) {
  const w = 150;
  const h = 34;
  const span = Math.max(max - min, 1);
  const pts = curve
    .map((c, i) => `${(i / Math.max(curve.length - 1, 1)) * w},${h - ((c.equity - min) / span) * (h - 4) - 2}`)
    .join(' ');
  const up = curve[curve.length - 1].equity >= curve[0].equity;
  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <svg width={w} height={h} className="rounded border border-zinc-800 bg-zinc-950">
        <polyline points={pts} fill="none" strokeWidth="1.5" className={up ? 'stroke-emerald-400' : 'stroke-rose-400'} />
      </svg>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-zinc-500">Equity curve</p>
        <p className="font-mono text-[10px] text-zinc-400">{curve.length} pts</p>
      </div>
    </div>
  );
}
