'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Copilot bridges — the light, ALWAYS-MOUNTED half of the copilot wiring.
//
// Extracted from copilot-panel.tsx so the heavy chat/research UI can be a
// lazy chunk: the bridges only need the market + strategy stores, while the
// panel (ai-sdk chat, markdown, agent cards) loads on demand. The two module
// refs below are the shared state between the always-on bridges and the
// lazily-mounted panel.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { resolveStrategyLegs, strategyById } from '@/lib/strategies';
import type { CopilotContextSnapshot } from '@/lib/copilot-context';
import type { ViewId } from '@/components/terminal/topbar';

/** Live spot mirror — strategy-loading event handlers read it synchronously. */
export const marketRef: { assets: Record<string, { spot: number }>; tsMs: number } = { assets: {}, tsMs: 0 };

/** The terminal-context snapshot shipped with every chat request. */
export const copilotContextRef: { current: CopilotContextSnapshot | null } = { current: null };

/** MarketSpotBridge subscribes to the market context and mirrors it into a
 *  module-level ref so strategy loading (an event handler) can read live spot. */
export function MarketSpotBridge() {
  const { market } = useMarket();
  useEffect(() => {
    marketRef.assets = market.assets;
    marketRef.tsMs = market.tsMs;
  }, [market]);
  return null;
}

const VIEW_LABELS: Record<string, string> = {
  strategies: 'Strategies',
  models: 'Mental Models',
  gamma: 'Gamma & Flow',
  chain: 'Option Chain',
  trade: 'Trading',
  paper: 'Paper Desk',
};

/** Mirrors the live terminal state (view · strategy · market) into a ref that
 *  ships with every chat request, so the copilot answers based on the data the
 *  platform is actually pulling and what the user is looking at. */
export function CopilotContextBridge({ view }: { view: ViewId }) {
  const { market, live, smooth } = useMarket();
  const { underlying, strategyName, legs, size, catalogId, mode } = useStrategy();
  useEffect(() => {
    const assets = (['BTC', 'ETH', 'SOL'] as const).map((a) => {
      const st = market.assets[a];
      const chg = (st?.change24h ?? 0) as number;
      return { asset: a, spot: st?.spot ?? 0, change24hPct: chg * 100 };
    });
    // Resolve the selected catalog strategy's legs when no custom strategy
    // is loaded — mirrors the strategies workspace preview semantics.
    let resolvedName = strategyName;
    let resolvedLegs = legs;
    const spec = catalogId ? strategyById(catalogId) : undefined;
    if (spec && legs.length === 0) {
      const spot = smooth[underlying]?.spot ?? market.assets[underlying]?.spot ?? 0;
      resolvedName = spec.name;
      resolvedLegs = resolveStrategyLegs(spec, spot);
    }
    copilotContextRef.current = {
      tsIso: new Date().toISOString(),
      activeSide: view === 'gamma' || view === 'chain' || view === 'trade' || view === 'models' ? 'analytics' : 'lab',
      activeView: view,
      viewLabel: VIEW_LABELS[view] ?? view,
      underlying,
      strategy: {
        catalogId,
        name: resolvedName,
        mode,
        size,
        legCount: resolvedLegs.length,
        legs: resolvedLegs.slice(0, 25).map((l) => ({
          kind: l.kind,
          side: l.side,
          qty: l.qty,
          strike: l.strike,
          expiryDays: l.expiryDays,
          fundingPeriodDays: l.fundingPeriodDays,
        })),
      },
      market: {
        source: live?.ok ? `live · ${live.source}` : 'connecting to venues',
        tsMs: market.tsMs,
        assets,
      },
    };
  }, [view, market, live, smooth, underlying, strategyName, legs, size, catalogId, mode]);

  return null;
}
