'use client';

// ─────────────────────────────────────────────────────────────────────────────
// VolOS v1.9 chrome — top bar (logo · 4 main tabs · live tickers · AI Copilot
// · RUST ENGINE status) and the terminal footer.
// ─────────────────────────────────────────────────────────────────────────────

import { Sparkles, CircleDot } from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { useUi, type MainView } from '@/stores/ui-store';
import { fmtPctSigned } from '@/lib/format';

const TABS: { id: MainView; label: string }[] = [
  { id: 'strategies', label: 'Strategies' },
  { id: 'chain', label: 'Option Chain' },
  { id: 'trading', label: 'Trading' },
  { id: 'desk', label: 'Paper Desk' },
];

export function VolosLogo() {
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex h-7 w-7 items-center justify-center">
        <div className="absolute inset-0 rotate-45 rounded-[4px] bg-teal-400/90" />
        <span className="relative text-[13px] font-black text-zinc-950">V</span>
      </div>
      <div className="leading-none">
        <div className="text-sm font-bold tracking-wide text-zinc-50">VolOS</div>
        <div className="mt-0.5 text-[8px] font-medium tracking-[0.18em] text-zinc-500">
          PERPETUAL OPTIONS TERMINAL
        </div>
      </div>
    </div>
  );
}

function Ticker({ sym, price, change }: { sym: string; price?: number; change?: number }) {
  const up = (change ?? 0) >= 0;
  return (
    <div className="flex items-baseline gap-1.5 font-mono text-[11px]">
      <span className="text-[9px] font-semibold tracking-wider text-zinc-500">{sym}</span>
      <span className="text-zinc-100">
        {price !== undefined ? price.toLocaleString('en-US', { maximumFractionDigits: price < 10 ? 2 : 0 }) : '—'}
      </span>
      {change !== undefined && (
        <span className={up ? 'text-teal-400' : 'text-rose-400'}>{fmtPctSigned(change, 2)}</span>
      )}
    </div>
  );
}

export function TopBar({ market }: { market: MarketState }) {
  const { view, setView, setCopilotOpen } = useUi();
  const btc = market.prices.BTC, eth = market.prices.ETH, sol = market.prices.SOL;

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-3">
      <VolosLogo />

      <nav className="ml-2 flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              view === t.id
                ? 'bg-teal-400/15 text-teal-300 ring-1 ring-teal-400/30'
                : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-4">
        <div className="flex items-center gap-4">
          <Ticker sym="BTC" price={btc?.price} change={btc?.change24h} />
          <Ticker sym="ETH" price={eth?.price} change={eth?.change24h} />
          <Ticker sym="SOL" price={sol?.price} change={sol?.change24h} />
        </div>
        <button
          type="button"
          onClick={() => setCopilotOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition-colors hover:border-teal-500/60 hover:text-teal-300"
        >
          <Sparkles className="h-3 w-3 text-teal-400" />
          AI Copilot
        </button>
        <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-zinc-400">
          <CircleDot className="h-3 w-3 text-teal-400" />
          RUST ENGINE · LIVE
        </div>
      </div>
    </header>
  );
}

export function TerminalFooter() {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-950 px-3 text-[9px] text-zinc-600">
      <span>
        VolOS perpetual options terminal. Simulated market data research prototype, not investment advice.
      </span>
      <span className="font-mono">
        rust engine: auxm · clob · svi · everlasting · 131 strategies / 25 legs | ai desk: vercel ai sdk · 6
        agents · glm | frontend: next.js 16
      </span>
    </footer>
  );
}
