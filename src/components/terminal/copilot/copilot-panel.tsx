'use client';

// The AI Copilot panel — the VolOS Agentic Research Desk UI.
// Chat tab: interactive Research Director with live agent activity cards.
// Research tab: the deep-research multi-agent pipeline.
//
// The copilot is GROUNDED in the live terminal context: every request ships
// a CopilotContextBridge snapshot (active view, selected strategy + legs,
// live exchange prices), so every answer is based on the data the platform
// is actually pulling and what the user is looking at.
//
// PROACTIVE CAPABILITIES: a one-click capability bar (POP+ · Risk− ·
// Profit+ · Alts · Teach) plus AUTO-SUGGESTIONS derived from the active
// view's live data — every chip quotes the user's real strategy numbers.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { useCopilot } from '@/stores/copilot-store';
import { useStrategy } from '@/stores/strategy-store';
import { useToast } from '@/hooks/use-toast';
import { useMarket } from '@/hooks/use-market';
import { resolveStrategyLegs, strategyById } from '@/lib/strategies';
import { analyzeStrategy } from '@/lib/pricing';
import type { Leg } from '@/lib/types';
import type { CopilotContextSnapshot } from '@/lib/copilot-context';
import { buildSuggestions, CAPABILITY_ACTIONS, type SuggestInput, type SuggestionChip } from '@/lib/copilot-suggest';
import { MarkdownLite } from './markdown-lite';
import { ToolCard } from './agent-activity';
import { ResearchView } from './research-view';
import { JsonCard, setCardActionHandlers } from './json-cards';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowUpRight, BookOpen, Crosshair, Globe, GraduationCap, Layers, Lightbulb,
  MessageSquare, Send, ShieldMinus, Sparkles, Square, Telescope, TrendingUp, User, X,
} from 'lucide-react';
import type { ViewId } from '@/components/terminal/topbar';

const CAPABILITY_ICONS: Record<string, React.ReactNode> = {
  pop: <TrendingUp className="h-3 w-3" />,
  risk: <ShieldMinus className="h-3 w-3" />,
  profit: <ArrowUpRight className="h-3 w-3" />,
  alt: <Layers className="h-3 w-3" />,
  teach: <GraduationCap className="h-3 w-3" />,
  research: <Globe className="h-3 w-3" />,
};

// --- live spot bridge -------------------------------------------------------------
// MarketSpotBridge subscribes to the market context and mirrors it into a
// module-level ref so strategy loading (an event handler) can read live spot.

let marketRef: { assets: Record<string, { spot: number }>; tsMs: number } | null = null;

export function MarketSpotBridge() {
  const { market } = useMarket();
  useEffect(() => {
    marketRef = { assets: market.assets, tsMs: market.tsMs };
  }, [market]);
  return null;
}

// --- copilot context bridge --------------------------------------------------------
// Mirrors the live terminal state (view · strategy · market) into a ref that
// ships with every chat request, so the copilot answers based on the data the
// platform is actually pulling and what the user is looking at.

let copilotContextRef: { current: CopilotContextSnapshot | null } = { current: null };

const VIEW_LABELS: Record<string, string> = {
  strategies: 'Strategies',
  gamma: 'Gamma & Flow',
  chain: 'Option Chain',
  trade: 'Trading',
  paper: 'Paper Desk',
};

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
      activeSide: view === 'gamma' || view === 'chain' || view === 'trade' ? 'analytics' : 'lab',
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
        source: live?.ok ? `live · ${live.source}` : market.source === 'rust' ? 'rust engine' : 'local sim',
        tsMs: market.tsMs,
        assets,
      },
    };
  }, [view, market, live, smooth, underlying, strategyName, legs, size, catalogId, mode]);

  return null;
}

interface CopilotPanelProps {
  view: ViewId;
  onView: (v: ViewId) => void;
}

/** Live strategy numbers for the suggestion chips — same resolution rules as
 *  the context bridge (catalog legs previewed on live spot when no custom
 *  strategy is loaded), analysed through the pricing engine. */
function useSuggestInput(view: ViewId): SuggestInput {
  const { market, smooth } = useMarket();
  const { underlying, strategyName, legs, size, catalogId } = useStrategy();
  return useMemo(() => {
    let resolvedLegs = legs;
    let resolvedName = strategyName;
    const spec = legs.length === 0 && catalogId ? strategyById(catalogId) : undefined;
    const asset = smooth[underlying] ?? market.assets[underlying];
    if (spec) {
      const spot = asset?.spot ?? 0;
      resolvedLegs = resolveStrategyLegs(spec, spot);
      resolvedName = spec.name;
    }
    let popPct: number | undefined;
    let maxLossUsd: number | undefined;
    let maxProfitUsd: number | undefined;
    let isCredit: boolean | undefined;
    if (resolvedLegs.length > 0 && asset) {
      try {
        const a = analyzeStrategy(resolvedLegs, underlying, asset, size);
        popPct = a.pop * 100;
        maxLossUsd = a.maxLoss.kind === 'value' ? a.maxLoss.value : undefined;
        maxProfitUsd = a.maxProfit.kind === 'value' ? a.maxProfit.value : undefined;
        isCredit = a.isCredit;
      } catch {
        /* numbers stay undefined — chips fall back to generic labels */
      }
    }
    return {
      view,
      underlying,
      strategyName: resolvedName,
      legCount: resolvedLegs.length,
      popPct,
      maxLossUsd,
      maxProfitUsd,
      isCredit,
    };
  }, [view, market, smooth, underlying, strategyName, legs, size, catalogId]);
}

export function CopilotPanel({ view, onView }: CopilotPanelProps) {
  const { open, tab, setTab, toggle } = useCopilot();
  const { underlying, strategyName, legs } = useStrategy();
  const { toast } = useToast();
  const ctx = copilotContextRef.current;

  // live strategy numbers → quantized so the derived suggestions stay stable
  // between market ticks (only re-chip when a number actually moves)
  const raw = useSuggestInput(view);
  const qPop = raw.popPct !== undefined ? Math.round(raw.popPct * 10) / 10 : undefined;
  const qLoss = raw.maxLossUsd !== undefined ? Math.round(raw.maxLossUsd / 25) * 25 : undefined;
  const qProfit = raw.maxProfitUsd !== undefined ? Math.round(raw.maxProfitUsd / 25) * 25 : undefined;
  const stableInput = useMemo<SuggestInput>(
    () => ({ view: raw.view, underlying: raw.underlying, strategyName: raw.strategyName, legCount: raw.legCount, popPct: qPop, maxLossUsd: qLoss, maxProfitUsd: qProfit, isCredit: raw.isCredit }),
    [raw.view, raw.underlying, raw.strategyName, raw.legCount, qPop, qLoss, qProfit, raw.isCredit],
  );
  const suggestions = useMemo(() => buildSuggestions(stableInput), [stableInput]);
  const inputRef = useRef(stableInput);
  inputRef.current = stableInput;

  const loadStrategyById = useCallback(
    (strategyId: string, u: string, size: number) => {
      const spec = strategyById(strategyId);
      if (!spec) {
        toast({ title: 'Strategy not found', description: strategyId, variant: 'destructive' });
        return;
      }
      const spot = marketRef?.assets[u]?.spot ?? (u === 'BTC' ? 97450 : u === 'ETH' ? 2462 : 138.4);
      const legs = resolveStrategyLegs(spec, spot);
      const n = useStrategy.getState().loadStrategy(spec.name, legs);
      if (size !== 1) useStrategy.getState().setSize(size);
      toast({ title: `Loaded ${spec.name}`, description: `${n} legs on ${u} — strategies workspace updated.` });
      onView('strategies');
    },
    [onView, toast],
  );

  /** Push an optimizer variant / custom leg set straight into the builder. */
  const loadCustomLegs = useCallback(
    (name: string, legSpecs: Array<{ kind: string; side: 'buy' | 'sell'; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }>, u: string, size: number) => {
      const nextLegs: Leg[] = legSpecs.slice(0, 25).map((l, i) => ({
        id: `copilot-${Date.now().toString(36)}-${i}`,
        kind: l.kind as Leg['kind'],
        side: l.side,
        qty: l.qty,
        ...(l.strike !== undefined ? { strike: l.strike } : {}),
        ...(l.expiryDays !== undefined ? { expiryDays: l.expiryDays } : {}),
        ...(l.fundingPeriodDays !== undefined ? { fundingPeriodDays: l.fundingPeriodDays } : {}),
      }));
      if (nextLegs.length === 0) {
        toast({ title: 'Nothing to load', description: 'The variant has no legs.', variant: 'destructive' });
        return;
      }
      const st = useStrategy.getState();
      if (u !== st.underlying) st.setUnderlying(u as never);
      const n = st.loadStrategy(name, nextLegs);
      if (size !== 1 && Number.isFinite(size)) st.setSize(size);
      toast({ title: `Loaded ${name}`, description: `${n} legs on ${u} — builder updated. Backtest it or paper-deploy it next.` });
      onView('strategies');
    },
    [onView, toast],
  );

  /** Paper-deploy an optimizer variant straight from its card: every leg is
   *  auto-routed to the venue with the best real quote and fills atomically
   *  on the paper account. Returns true when the package landed. */
  const paperDeployLegs = useCallback(
    async (
      name: string,
      legSpecs: Array<{ kind: string; side: 'buy' | 'sell'; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }>,
      u: string,
      size: number,
    ): Promise<boolean> => {
      const legs = legSpecs
        .filter((l) => (l.kind === 'call' || l.kind === 'put') && Number(l.qty) > 0 && Number(l.strike) > 0)
        .slice(0, 25)
        .map((l) => ({
          kind: l.kind as 'call' | 'put',
          side: l.side,
          qty: Number(l.qty),
          strike: Number(l.strike),
          expiryDays: l.expiryDays,
        }));
      if (legs.length === 0) {
        toast({ title: 'Nothing to deploy', description: 'The variant has no dated option legs to paper-trade.', variant: 'destructive' });
        return false;
      }
      try {
        const res = await fetch('/api/paper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'strategy',
            name,
            asset: u,
            venue: 'auto',
            sizeMultiplier: Number.isFinite(size) && size > 0 ? size : 1,
            legs,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          name?: string;
          legs?: Array<{ venue?: string }>;
          netPremium?: number;
          cashAfter?: number;
        };
        if (!res.ok || !data.ok) {
          toast({ title: 'Paper-deploy failed', description: data.error ?? `HTTP ${res.status}`, variant: 'destructive' });
          return false;
        }
        const venues = [...new Set((data.legs ?? []).map((l) => l.venue).filter(Boolean))].join(' · ');
        toast({
          title: `Paper-deployed ${data.name ?? name}`,
          description:
            `${(data.legs ?? []).length} legs filled${venues ? ` on ${venues}` : ''}` +
            (data.netPremium != null ? ` · net premium ${data.netPremium >= 0 ? '+' : '−'}$${Math.abs(data.netPremium).toFixed(2)}` : '') +
            (data.cashAfter != null ? ` · cash $${Math.round(data.cashAfter).toLocaleString('en-US')}` : '') +
            ' — positions are live on the Paper Desk.',
        });
        return true;
      } catch (err) {
        toast({ title: 'Paper-deploy failed', description: err instanceof Error ? err.message : 'network error', variant: 'destructive' });
        return false;
      }
    },
    [toast],
  );

  // ── Generative-UI card action bridge ─────────────────────────────────────
  // Buttons inside json-render cards (render_card tool) drive the REAL
  // platform through the same handlers the tool cards use: load_strategy →
  // strategy builder, paper_deploy → paper desk with the CURRENT strategy's
  // resolved legs, open_url → new tab (handled in-card).
  useEffect(() => {
    setCardActionHandlers({
      onLoadStrategy: (strategyId) => loadStrategyById(strategyId, underlying, 1),
      onPaperDeploy: async (variantName) => {
        const st = useStrategy.getState();
        const u = st.underlying;
        let legSpecs: Array<{ kind: string; side: 'buy' | 'sell'; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }> = st.legs.map((l) => ({
          kind: l.kind,
          side: l.side,
          qty: l.qty,
          ...(l.strike !== undefined ? { strike: l.strike } : {}),
          ...(l.expiryDays !== undefined ? { expiryDays: l.expiryDays } : {}),
          ...(l.fundingPeriodDays !== undefined ? { fundingPeriodDays: l.fundingPeriodDays } : {}),
        }));
        if (legSpecs.length === 0 && st.catalogId) {
          const spec = strategyById(st.catalogId);
          if (spec) {
            const spot = marketRef?.assets[u]?.spot ?? (u === 'BTC' ? 97450 : u === 'ETH' ? 2462 : 138.4);
            legSpecs = resolveStrategyLegs(spec, spot).map((l) => ({
              kind: l.kind,
              side: l.side,
              qty: l.qty,
              ...(l.strike !== undefined ? { strike: l.strike } : {}),
              ...(l.expiryDays !== undefined ? { expiryDays: l.expiryDays } : {}),
              ...(l.fundingPeriodDays !== undefined ? { fundingPeriodDays: l.fundingPeriodDays } : {}),
            }));
          }
        }
        await paperDeployLegs(variantName ?? st.strategyName ?? 'Copilot strategy', legSpecs, u, st.size);
      },
    });
    return () => setCardActionHandlers(null);
  }, [loadStrategyById, paperDeployLegs, underlying, toast]);

  if (!open) return null;

  return (
    <aside className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-zinc-800/80 bg-[#070a0e]/98 shadow-2xl backdrop-blur md:static md:z-auto md:w-[440px] md:shrink-0 md:shadow-none">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/60 px-3 py-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-teal-500 shadow-[0_0_12px_rgba(139,92,246,0.35)]">
          <Sparkles className="h-3.5 w-3.5 text-zinc-950" strokeWidth={2.5} />
        </div>
        <div className="leading-none">
          <p className="text-[12px] font-bold tracking-tight text-zinc-50">
            Agentic Research Desk
          </p>
          <p className="mt-0.5 text-[8.5px] uppercase tracking-[0.16em] text-zinc-500">
            volos ai · vercel ai sdk · glm
          </p>
        </div>
        <button onClick={toggle} className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Close copilot">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* tabs */}
      <div className="flex gap-1 border-b border-zinc-800/80 bg-zinc-950/40 px-3 py-1.5">
        <button
          onClick={() => setTab('chat')}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
            tab === 'chat' ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <MessageSquare className="h-3 w-3" /> Copilot
        </button>
        <button
          onClick={() => setTab('research')}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
            tab === 'research' ? 'bg-violet-950/50 text-violet-300 ring-1 ring-violet-500/30' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Telescope className="h-3 w-3" /> Deep Research
        </button>
        <span
          className="ml-auto flex items-center gap-1 self-center font-mono text-[9px] text-zinc-600"
          title={ctx ? `Copilot is grounded in your live terminal context: ${ctx.viewLabel} · ${ctx.strategy.name} · ${ctx.market.source}` : 'Copilot context: waiting for live data…'}
        >
          <Crosshair className="h-2.5 w-2.5 text-teal-500/80" />
          {underlying}
          {legs.length > 0 && <span className="text-zinc-700">·</span>}
          {legs.length > 0 && <span className="max-w-[90px] truncate text-zinc-500">{strategyName}</span>}
        </span>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1">
        {tab === 'chat' ? (
          <ChatTab
            onLoadStrategy={loadStrategyById}
            onLoadLegs={loadCustomLegs}
            onPaperDeploy={paperDeployLegs}
            suggestions={suggestions}
            getInput={() => inputRef.current}
          />
        ) : (
          <ResearchView onView={onView} />
        )}
      </div>
    </aside>
  );
}


// --- chat tab --------------------------------------------------------------------

interface ChatTabProps {
  onLoadStrategy: (id: string, u: string, size: number) => void;
  onLoadLegs: (
    name: string,
    legs: Array<{ kind: string; side: 'buy' | 'sell'; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }>,
    u: string,
    size: number,
  ) => void;
  onPaperDeploy: (
    name: string,
    legs: Array<{ kind: string; side: 'buy' | 'sell'; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }>,
    u: string,
    size: number,
  ) => Promise<boolean>;
  suggestions: SuggestionChip[];
  getInput: () => SuggestInput;
}

function ChatTab({ onLoadStrategy, onLoadLegs, onPaperDeploy, suggestions, getInput }: ChatTabProps) {
  const { messages, input, handleInputChange, handleSubmit, isLoading, stop, reload, append, error, setMessages } =
    useChat({ api: '/api/ai/copilot' });
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Every request ships the freshest live terminal context snapshot.
  const ctxBody = () => ({ context: copilotContextRef.current });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSubmit(e, { body: ctxBody() });
  };

  // One-click send (auto-suggestions · capability bar): append the question
  // as a real user message and fire immediately — button clicked → question
  // asked → tools pull live data → streamed answer.
  const ask = useCallback(
    (q: string) => {
      if (isLoading || !q.trim()) return;
      append({ role: 'user', content: q }, { body: ctxBody() });
    },
    [isLoading, append],
  );

  const sendCapability = useCallback(
    (cap: (typeof CAPABILITY_ACTIONS)[number]) => {
      ask(cap.build(getInput()));
    },
    [ask, getInput],
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && <EmptyState />}
        {messages.map((m) => (
          <div key={m.id} className="space-y-2">
            {m.role === 'user' ? (
              <div className="flex justify-end">
                <div className="flex max-w-[85%] items-start gap-1.5">
                  <div className="rounded-lg rounded-br-sm bg-teal-950/60 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-teal-50 ring-1 ring-teal-800/50">
                    {textOf(m)}
                  </div>
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800">
                    <User className="h-3 w-3 text-zinc-400" />
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {(m.parts ?? []).map((part, i) => {
                  if (part.type === 'text' && part.text.trim().length > 0) {
                    return (
                      <div key={i} className="rounded-lg rounded-bl-sm border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-2">
                        <MarkdownLite text={part.text} />
                      </div>
                    );
                  }
                  if (part.type === 'tool-invocation') {
                    const inv = part.toolInvocation;
                    // Generative-UI cards: render_card tool args ARE the card spec,
                    // rendered through the VolOS json-render registry as native
                    // tables / stat grids / charts / digests / action buttons.
                    if (
                      inv.toolName === 'render_card' &&
                      inv.args &&
                      typeof inv.args === 'object' &&
                      'elements' in (inv.args as Record<string, unknown>)
                    ) {
                      const rejected =
                        'result' in inv &&
                        (inv.result as { rendered?: boolean } | undefined)?.rendered === false;
                      if (!rejected) {
                        return <JsonCard key={i} spec={inv.args} />;
                      }
                    }
                    return (
                      <ToolCard
                        key={i}
                        invocation={part.toolInvocation}
                        onLoadStrategy={onLoadStrategy}
                        onLoadLegs={onLoadLegs}
                        onPaperDeploy={onPaperDeploy}
                      />
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role !== 'user' && (
          <div className="flex items-center gap-2 px-1 text-[10.5px] text-zinc-500">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-400 [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-400 [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-400 [animation-delay:240ms]" />
            </span>
            research desk pulling live data…
          </div>
        )}
        {error && (
          <div className="rounded-md border border-rose-900/60 bg-rose-950/30 px-2.5 py-2 text-[10.5px] text-rose-300">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                {(error as Error).message || 'Copilot request failed.'}
              </span>
              <button
                type="button"
                onClick={() => reload({ body: ctxBody() })}
                className="shrink-0 rounded border border-rose-800/60 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-rose-200 hover:bg-rose-900/40"
              >
                retry
              </button>
              <button
                type="button"
                onClick={() => setMessages(messages.slice(0, -1))}
                className="shrink-0 rounded px-1 py-0.5 text-[9.5px] text-rose-400 hover:text-rose-200"
              >
                dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {/* auto-suggestions — derived from the ACTIVE VIEW's live data; one click sends */}
      {messages.length === 0 && suggestions.length > 0 && (
        <div className="space-y-1.5 border-t border-zinc-800/70 p-3">
          <p className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-600">
            <Lightbulb className="h-2.5 w-2.5 text-amber-400/80" />
            suggested for this view · live numbers
          </p>
          {suggestions.map((s) => (
            <button
              key={s.id}
              onClick={() => ask(s.prompt)}
              disabled={isLoading}
              title={s.prompt}
              className="flex w-full items-center gap-2 rounded-md border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-1.5 text-left text-[10.5px] text-zinc-400 transition hover:border-teal-800/60 hover:bg-teal-950/20 hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SuggestionIcon kind={s.kind} />
              <span className="min-w-0 flex-1">{s.label}</span>
              <Send className="h-2.5 w-2.5 shrink-0 text-zinc-700" />
            </button>
          ))}
        </div>
      )}

      {/* capability bar — always-available one-click actions on the current strategy */}
      <div className="flex items-center gap-1 border-t border-zinc-800/70 bg-zinc-950/40 px-2.5 py-1.5">
        {CAPABILITY_ACTIONS.map((cap) => (
          <button
            key={cap.id}
            onClick={() => sendCapability(cap)}
            title={cap.title}
            disabled={isLoading}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-zinc-800/70 bg-zinc-900/50 px-1 py-1 text-[9.5px] font-semibold tracking-tight text-zinc-400 transition hover:border-teal-700/60 hover:bg-teal-950/30 hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {CAPABILITY_ICONS[cap.id]}
            {cap.label}
          </button>
        ))}
      </div>

      {/* input */}
      <form
        onSubmit={submit}
        className="border-t border-zinc-800/70 bg-zinc-950/40 p-2.5"
      >
        <div className="flex items-end gap-2">
          <Textarea
            data-copilot-input
            value={input}
            onChange={handleInputChange}
            placeholder="Ask the research desk anything — analysis, strategies, likelihoods…"
            className="max-h-32 min-h-[36px] flex-1 resize-none border-zinc-800 bg-zinc-900/70 text-[11.5px] placeholder:text-zinc-600"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e);
              }
            }}
          />
          {isLoading ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-8 w-8 p-0"
              aria-label="Stop generating"
              onClick={(e) => { e.preventDefault(); stop(); }}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              className="h-8 w-8 bg-teal-600/80 p-0 text-zinc-950 hover:bg-teal-500"
              aria-label="Send message"
              disabled={input.trim().length === 0}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[9px] text-zinc-600">
            9 agents: Trend Scout · Pattern Hawk · Macro Owl · Vol Oracle · Risk Quant · Ledger Hound · Gamma Ray · Legs Weaver · Strategy Smith
          </span>
          <span className="flex items-center gap-2">
            {messages.length > 0 && !isLoading && (
              <>
                <button
                  type="button"
                  onClick={() => reload({ body: ctxBody() })}
                  className="text-[9px] text-zinc-500 underline hover:text-zinc-300"
                >
                  regenerate
                </button>
                <button
                  type="button"
                  onClick={() => setMessages([])}
                  className="text-[9px] text-zinc-500 underline hover:text-zinc-300"
                >
                  clear chat
                </button>
              </>
            )}
          </span>
        </div>
      </form>
    </div>
  );
}

function textOf(m: { content?: string | Array<{ type: string; text?: string }> }): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
  return '';
}

/** Tiny per-kind icon for suggestion chips. */
function SuggestionIcon({ kind }: { kind: SuggestionChip['kind'] }) {
  switch (kind) {
    case 'optimize':
      return <TrendingUp className="h-3 w-3 shrink-0 text-teal-400/80" />;
    case 'alternative':
      return <Layers className="h-3 w-3 shrink-0 text-violet-400/80" />;
    case 'teach':
      return <BookOpen className="h-3 w-3 shrink-0 text-amber-400/80" />;
    case 'research':
      return <Globe className="h-3 w-3 shrink-0 text-sky-400/80" />;
    case 'paper':
      return <ShieldMinus className="h-3 w-3 shrink-0 text-sky-400/80" />;
    case 'trade':
      return <ArrowUpRight className="h-3 w-3 shrink-0 text-emerald-400/80" />;
    default:
      return <Lightbulb className="h-3 w-3 shrink-0 text-zinc-500" />;
  }
}

function EmptyState() {
  return (
    <div className="space-y-4 px-1 pt-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500/20 to-violet-500/20">
        <Sparkles className="h-7 w-7 text-teal-300" />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-zinc-200">VolOS Agentic Research Desk</p>
        <p className="mx-auto mt-1 max-w-[340px] text-[10.5px] leading-relaxed text-zinc-500">
          Nine specialist agents — technical, chart, macro, volatility, profitability, backtest, 0DTE, multileg/multihop
          and strategy design — research live exchange data (Deribit · Bybit · OKX · Aevo · Paradex), stress-test
          likelihoods and build options strategies with you.
        </p>
      </div>
      <div className="mx-auto grid max-w-[340px] grid-cols-3 gap-1.5 text-[9.5px] text-zinc-500">
        {[
          ['📈', 'Trend Scout'],
          ['🕯️', 'Pattern Hawk'],
          ['🦉', 'Macro Owl'],
          ['🌊', 'Vol Oracle'],
          ['🎯', 'Risk Quant'],
          ['📜', 'Ledger Hound'],
          ['⚡', 'Gamma Ray'],
          ['🧩', 'Legs Weaver'],
          ['⚒️', 'Strategy Smith'],
        ].map(([e, n]) => (
          <div key={n} className="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-1.5 py-1.5">
            <div className="text-sm leading-none">{e}</div>
            <div className="mt-1 truncate">{n}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
