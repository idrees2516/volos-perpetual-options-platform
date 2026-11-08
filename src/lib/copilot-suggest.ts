// ─────────────────────────────────────────────────────────────────────────────
// copilot-suggest — AUTO-SUGGESTIONS for the AI Copilot, derived from the
// ACTIVE VIEW and the LIVE DATA the platform is pulling. The chips are not
// static: they quote the user's actual strategy numbers (POP, max loss,
// max profit from the pricing engine) and change with the workspace.
// Pure function — client-side, fed by the market + strategy stores.
// ─────────────────────────────────────────────────────────────────────────────

export type SuggestKind = 'optimize' | 'alternative' | 'teach' | 'research' | 'paper' | 'trade';

export interface SuggestionChip {
  id: string;
  kind: SuggestKind;
  /** Short label rendered on the chip. */
  label: string;
  /** The full prompt sent to the copilot on click. */
  prompt: string;
}

export interface SuggestInput {
  view: string;
  underlying: string;
  strategyName: string;
  legCount: number;
  /** Live strategy analysis numbers (undefined when no option legs). */
  popPct?: number;
  maxLossUsd?: number;
  maxProfitUsd?: number;
  isCredit?: boolean;
}

const usd = (x: number) =>
  `$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) < 100 ? 1 : 0 })}`;

/**
 * Build 4–6 view-aware, data-grounded suggestion chips. Every chip is a
 * complete prompt — one click sends it straight to the research desk.
 */
export function buildSuggestions(input: SuggestInput): SuggestionChip[] {
  const u = input.underlying;
  const strat = input.strategyName || 'the current strategy';
  const popKnown = input.popPct !== undefined && Number.isFinite(input.popPct) && input.popPct > 0;
  const lossKnown = input.maxLossUsd !== undefined && Number.isFinite(input.maxLossUsd) && input.maxLossUsd !== 0;
  const hasStrategy = input.legCount > 0;

  switch (input.view) {
    // ── STRATEGIES workspace: the strategy lab prompts ─────────────────────
    case 'strategies': {
      if (hasStrategy) {
        const chips: SuggestionChip[] = [
          {
            id: 'pop',
            kind: 'optimize',
            label: popKnown ? `Raise POP — now ${input.popPct!.toFixed(0)}%` : 'Raise probability of profit',
            prompt: `Increase the probability of profit on my current strategy (${strat} on ${u}${
              popKnown ? `, currently ${input.popPct!.toFixed(1)}% POP` : ''
            }). Run the optimizer with goal=increase_pop on my strategy legs, show me the ranked adjustment variants with exact deltas, and recommend the best one.`,
          },
          {
            id: 'loss',
            kind: 'optimize',
            label: lossKnown ? `Cut max loss — now ${usd(Math.abs(input.maxLossUsd!))}` : 'Decrease my max loss / risk',
            prompt: `Decrease the losses and risk on my current strategy (${strat} on ${u}${
              lossKnown ? `, currently ${usd(Math.abs(input.maxLossUsd!))} max loss` : ''
            }). Run the optimizer with goal=reduce_risk on my strategy legs — shrink the max loss and margin — and tell me exactly what I trade away for it.`,
          },
          {
            id: 'profit',
            kind: 'optimize',
            label: 'Boost profit potential',
            prompt: `Increase the profit potential on my current strategy (${strat} on ${u}). Run the optimizer with goal=increase_profit on my strategy legs, show the variants ranked by max profit and EV improvement, and recommend when each is the right choice.`,
          },
          {
            id: 'alt',
            kind: 'alternative',
            label: `Alternatives to ${strat}`,
            prompt: `Show me all alternative strategies to my current ${strat} on ${u} — compare them live against it (POP, max profit, max loss, EV, credit vs debit) and recommend the single best swap for my situation.`,
          },
          {
            id: 'teach',
            kind: 'teach',
            label: 'Teach me every metric here',
            prompt: `Teach me all the metrics on my current strategy (${strat} on ${u}) and the live market data — explain each one (POP, EV, max profit/loss, breakevens, Greeks, premium, margin) with my actual live numbers, how I can use each beneficially to increase profit and decrease losses, and the traps to avoid.`,
          },
          {
            id: 'web-industry',
            kind: 'research',
            label: `Web: how the industry plays ${strat}`,
            prompt: `Research the OPTIONS INDUSTRY WEB for how professionals construct and manage ${strat} positions on ${u} right now — search for current commentary, position-sizing and management rules from analytics desks and research shops (Deribit Insights, Paradigm Research, Laevitas…), scrape the best one or two pieces, then combine what the web says with MY live strategy numbers (get_market_state + analyze_strategy) into a research digest card with clickable sources plus actionable buttons.`,
          },
        ];
        return chips;
      }
      return [
        {
          id: 'tour',
          kind: 'teach',
          label: 'Teach me the strategy families',
          prompt: `Teach me the strategy catalog on ${u}: the seven families, when to use each in which market regime, and how POP / max loss / profit shape differ between them. Ground it in today's live ${u} data.`,
        },
        {
          id: 'best',
          kind: 'research',
          label: `Best strategy on ${u} right now`,
          prompt: `Research ${u} live and recommend the single best strategy for the current regime — technicals, vol, macro — with POP, EV and risk numbers to justify it.`,
        },
        {
          id: 'income',
          kind: 'research',
          label: 'Highest-POP income structure',
          prompt: `Find me the highest probability-of-profit income strategy on ${u} right now with defined risk. Compare the top candidates live and rank them.`,
        },
        {
          id: 'teach-metrics',
          kind: 'teach',
          label: 'Explain POP and the Greeks',
          prompt: `Explain probability of profit, delta, gamma, vega and theta from first principles using live ${u} numbers — and teach me how traders use each one to make money.`,
        },
        {
          id: 'web-outlook',
          kind: 'research',
          label: `Web: ${u} options market outlook`,
          prompt: `Research the WEB for the current ${u} options market outlook — IV levels and sentiment from industry sources (news wires, analytics desks, research shops) — then pair it with our own live market state and volatility regime analysis, and render a research digest card with clickable sources and a stats card of the live desk numbers.`,
        },
      ];
    }

    // ── GAMMA & FLOW: dealer positioning / 0DTE / skew ─────────────────────
    case 'gamma':
      return [
        {
          id: 'gex',
          kind: 'teach',
          label: 'Explain GEX & dealer positioning',
          prompt: `Teach me gamma exposure and dealer positioning on ${u} using the live GEX data on my screen: what the heatmaps mean, where the gamma flip level is, how market-maker hedging pins or accelerates price — and how I can trade it beneficially.`,
        },
        {
          id: 'regime',
          kind: 'research',
          label: 'GEX regime → strategy pick',
          prompt: `Read the live gamma/flow data for ${u} on my screen: are dealers long or short gamma, and at which strikes? Based on the regime, tell me whether to run a premium-selling range structure or a long-convexity one — with a concrete strategy and its live numbers.`,
        },
        {
          id: '0dte',
          kind: 'trade',
          label: `0DTE setup on ${u} today`,
          prompt: `Scan the 0DTE setup on ${u} right now: expected move, gamma levels, pin risk and the best same-day structure — give me the numbers and the plan.`,
        },
        {
          id: 'flow',
          kind: 'teach',
          label: 'How do I read the flow tape?',
          prompt: `Teach me how to read the options flow tape and skew on ${u} that I'm looking at: which prints matter (sweep vs block), what skew tells me about fear, and concrete ways to use flow data to time entries and exits.`,
        },
      ];

    // ── OPTION CHAIN: strikes, skew, liquidity ─────────────────────────────
    case 'chain':
      return [
        {
          id: 'strikes',
          kind: 'research',
          label: 'Best strikes on this chain',
          prompt: `From the live ${u} option chain on my screen, which strikes offer the best combination of liquidity, premium and risk for an income structure? Give me the exact strikes and the numbers.`,
        },
        {
          id: 'skew',
          kind: 'teach',
          label: 'Explain this chain\'s IV skew',
          prompt: `Explain the IV skew I'm seeing in the live ${u} chain: which side is expensive, why, and teach me the concrete ways traders exploit rich skew (put credit spreads, call calendars, ratio structures) with today's numbers.`,
        },
        {
          id: 'build',
          kind: 'trade',
          label: 'Build a structure from this chain',
          prompt: `Build me a defined-risk structure on ${u} using strikes from the live chain on my screen: choose the legs, price it live (POP, max profit, max loss, EV) and tell me why these strikes.`,
        },
        {
          id: 'ivrank',
          kind: 'teach',
          label: 'Is IV cheap or rich here?',
          prompt: `Is implied volatility on ${u} cheap or rich right now? Teach me how to tell from the chain and the vol regime, and what that means for whether I should buy or sell premium today.`,
        },
      ];

    // ── TRADING: execution data ────────────────────────────────────────────
    case 'trade':
      return [
        {
          id: 'read-book',
          kind: 'teach',
          label: 'Teach me the book & tape',
          prompt: `Teach me how to read the L2 order book and trade tape on the ${u} engine CLOB I'm looking at: depth, imbalance, spoofing tells, and how execution data improves my entries and exits.`,
        },
        {
          id: 'routing',
          kind: 'teach',
          label: 'How does smart routing help me?',
          prompt: `Explain how the platform's smart order routing across the nine venues gets me better fills on ${u} options — spread costs, venue liquidity, RFQ vs CLOB — and how much that actually saves on a real structure.`,
        },
        {
          id: 'hedge',
          kind: 'trade',
          label: 'Hedge my delta here',
          prompt: `I'm watching the ${u} trading desk. What's the smartest delta-hedge or risk-overlay structure for ${u} right now? Price it live with real numbers.`,
        },
      ];

    // ── PAPER DESK: account performance ───────────────────────────────────
    case 'paper':
      return [
        {
          id: 'review',
          kind: 'paper',
          label: 'Review my paper account',
          prompt: `Analyse my paper trading account: equity, open positions with live marks, P&L, what's working and what's bleeding. Be specific about winners and losers.`,
        },
        {
          id: 'cut-loss',
          kind: 'paper',
          label: 'Decrease losses on open positions',
          prompt: `Look at my paper account positions and help me decrease losses: which positions are deteriorating, should I close or hedge them, and what protective overlay would cut my downside right now? Then teach me the framework so I can do this myself.`,
        },
        {
          id: 'boost',
          kind: 'paper',
          label: 'Increase profit on my book',
          prompt: `How do I increase profit on my current paper positions? Suggest overlays or add-ons (rolls, ratio spreads, extra income legs) priced at live quotes, and show the improved POP/EV for each.`,
        },
        {
          id: 'teach-book',
          kind: 'teach',
          label: 'Teach me position management',
          prompt: `Teach me professional position management using my paper account as the live example: scaling in/out, profit-taking rules, rolling losers, the 50%/21% management rules — and how each applies to what I actually hold.`,
        },
      ];

    default:
      return [];
  }
}

/** Compact capability actions — always available above the input. */
export interface CapabilityAction {
  id: string;
  label: string;
  title: string;
  build: (input: SuggestInput) => string;
}

export const CAPABILITY_ACTIONS: CapabilityAction[] = [
  {
    id: 'pop',
    label: 'POP+',
    title: 'Increase probability of profit on the current strategy',
    build: (i) =>
      `Increase the probability of profit on my current strategy${i.legCount > 0 ? ` (${i.strategyName} on ${i.underlying}${
        i.popPct ? `, now ${i.popPct.toFixed(1)}% POP` : ''
      })` : ''}. Optimize it with goal=increase_pop, show the ranked variants with exact deltas and recommend the best.`,
  },
  {
    id: 'risk',
    label: 'Risk−',
    title: 'Decrease max loss / risk on the current strategy',
    build: (i) =>
      `Decrease the losses and risk on my current strategy${i.legCount > 0 ? ` (${i.strategyName} on ${i.underlying}${
        i.maxLossUsd ? `, now ${usd(Math.abs(i.maxLossUsd))} max loss` : ''
      })` : ''}. Optimize it with goal=reduce_risk — cut the worst case — and quantify what it costs me.`,
  },
  {
    id: 'profit',
    label: 'Profit+',
    title: 'Increase profit potential on the current strategy',
    build: (i) =>
      `Increase the profit potential on my current strategy${i.legCount > 0 ? ` (${i.strategyName} on ${i.underlying})` : ''}. Optimize it with goal=increase_profit — bigger ceiling and EV — and rank the variants.`,
  },
  {
    id: 'alt',
    label: 'Alts',
    title: 'Show alternative strategies to the current one',
    build: (i) =>
      `Show me all alternative strategies${i.legCount > 0 ? ` to my ${i.strategyName} on ${i.underlying}` : ` for ${i.underlying}`} — compare them live (POP, max profit, max loss, EV) and recommend the best swap.`,
  },
  {
    id: 'teach',
    label: 'Teach',
    title: 'Teach me every metric on my screen with live numbers',
    build: (i) =>
      `Teach me every metric${i.legCount > 0 ? ` on my ${i.strategyName} (${i.underlying})` : ` and the live ${i.underlying} market data I'm looking at`} — explain each with my actual live numbers, how to use it beneficially to increase profit and cut losses, and the traps to avoid.`,
  },
  {
    id: 'research',
    label: 'Research',
    title: 'Web-research the options industry for this view and render digest cards',
    build: (i) =>
      `Research the OPTIONS INDUSTRY WEB for ${i.underlying}${i.legCount > 0 ? ` and how professionals run ${i.strategyName} positions like mine` : ' options market conditions'} — current IV sentiment, positioning commentary and management rules from industry sources — then combine the web findings with MY live desk numbers (get_market_state${i.legCount > 0 ? ', analyze_strategy' : ''}) and render a research digest card with clickable sources, a stats card of the live numbers, and action buttons.`,
  },
];
