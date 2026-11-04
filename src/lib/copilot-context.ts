// ─────────────────────────────────────────────────────────────────────────────
// copilot-context — the live terminal context snapshot that grounds the AI
// Copilot in EXACTLY what the user is seeing: active workspace, selected
// strategy (legs, size, underlying), live exchange prices and the analytics
// the platform pulls. A compact, pure-data module — shared type + formatter
// used by BOTH the client (bridge → useChat body) and the server route
// (system prompt injection).
// ─────────────────────────────────────────────────────────────────────────────

export interface CopilotContextLeg {
  kind: string;
  side: 'buy' | 'sell';
  qty: number;
  strike?: number;
  expiryDays?: number;
  fundingPeriodDays?: number;
}

export interface CopilotContextSnapshot {
  tsIso: string;
  /** Which workbench side is active. */
  activeSide: 'analytics' | 'lab';
  /** Active view id + human label. */
  activeView: string;
  viewLabel: string;
  underlying: string;
  strategy: {
    catalogId: string;
    name: string;
    mode: string;
    size: number;
    legCount: number;
    legs: CopilotContextLeg[];
  };
  market: {
    source: string;
    tsMs: number;
    assets: Array<{ asset: string; spot: number; change24hPct: number }>;
  };
}

/** Render the snapshot as a compact markdown block for the system prompt. */
export function formatCopilotContext(ctx: CopilotContextSnapshot): string {
  const legs =
    ctx.strategy.legs.length === 0
      ? '_none loaded yet_'
      : ctx.strategy.legs
          .map((l) => {
            const bits: string[] = [`${l.side} ${l.qty}× ${l.kind.replace(/_/g, ' ')}`];
            if (l.strike !== undefined) bits.push(`K=${l.strike}`);
            if (l.expiryDays !== undefined) bits.push(`${l.expiryDays}d`);
            if (l.fundingPeriodDays !== undefined) bits.push(`${l.fundingPeriodDays}d funding`);
            return bits.join(' ');
          })
          .join(' · ');

  const market = ctx.market.assets
    .map((a) => `${a.asset} $${a.spot.toFixed(a.spot >= 1000 ? 0 : 2)} (${a.change24hPct >= 0 ? '+' : ''}${a.change24hPct.toFixed(2)}% 24h)`)
    .join(' · ');

  return [
    '## LIVE TERMINAL CONTEXT (what the user is looking at RIGHT NOW)',
    `- Workspace: ${ctx.viewLabel} (side: ${ctx.activeSide === 'analytics' ? 'Analytics' : 'Strategy Lab'}, view id: ${ctx.activeView})`,
    `- Underlying focus: ${ctx.underlying}`,
    `- Loaded strategy: ${ctx.strategy.name} (catalog id: ${ctx.strategy.catalogId}, mode: ${ctx.strategy.mode}, size ×${ctx.strategy.size}, ${ctx.strategy.legCount} legs)`,
    `  - Legs: ${legs}`,
    `- Live market snapshot (${ctx.market.source}, ${new Date(ctx.market.tsMs).toISOString()}): ${market}`,
    '',
    'Use this context to tailor every answer to the user\'s CURRENT screen and strategy. ',
    'For precise/current numbers still prefer your tools (get_market_state, analyze_strategy, get_live_options_chain, …); ',
    'when the user says "my strategy" / "this view" / "current", the context above is what they mean.',
  ].join('\n');
}
