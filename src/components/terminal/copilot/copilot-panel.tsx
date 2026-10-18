'use client';

// The AI Copilot panel — the VolOS Agentic Research Desk UI.
// Chat tab: interactive Research Director with live agent activity cards.
// Research tab: the deep-research multi-agent pipeline.

import { useCallback, useEffect, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { useCopilot } from '@/stores/copilot-store';
import { useStrategy } from '@/stores/strategy-store';
import { useToast } from '@/hooks/use-toast';
import { useMarket } from '@/hooks/use-market';
import { resolveStrategyLegs, strategyById } from '@/lib/strategies';
import { MarkdownLite } from './markdown-lite';
import { ToolCard } from './agent-activity';
import { ResearchView } from './research-view';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MessageSquare, Send, Sparkles, Square, Telescope, User, X } from 'lucide-react';
import type { ViewId } from '@/components/terminal/topbar';

const QUICK_PROMPTS = [
  'Deep dive BTC: technicals, charts, macro and vol — then recommend a strategy',
  'Best income strategy on ETH for the next 30 days?',
  'Is SOL overbought? Check momentum and chart patterns',
  'Design a defined-risk hedge for a long BTC position',
  'Compare iron condor vs butterfly on BTC right now',
];

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

interface CopilotPanelProps {
  view: ViewId;
  onView: (v: ViewId) => void;
}

export function CopilotPanel({ view, onView }: CopilotPanelProps) {
  const { open, tab, setTab, toggle } = useCopilot();
  const { underlying } = useStrategy();
  const { toast } = useToast();

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
      toast({ title: `Loaded ${spec.name}`, description: `${n} legs on ${u} — builder updated.` });
      onView('builder');
    },
    [onView, toast],
  );

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
        <span className="ml-auto self-center font-mono text-[9px] text-zinc-600">ctx: {underlying}</span>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1">
        {tab === 'chat' ? <ChatTab onLoadStrategy={loadStrategyById} /> : <ResearchView onView={onView} />}
      </div>
      {view === 'builder' ? null : null}
    </aside>
  );
}


// --- chat tab --------------------------------------------------------------------

function ChatTab({ onLoadStrategy }: { onLoadStrategy: (id: string, u: string, size: number) => void }) {
  const { messages, input, handleInputChange, handleSubmit, isLoading, stop, reload } = useChat({
    api: '/api/ai/copilot',
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
                    return <ToolCard key={i} invocation={part.toolInvocation} onLoadStrategy={onLoadStrategy} />;
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
            research desk working…
          </div>
        )}
      </div>

      {/* quick prompts */}
      {messages.length === 0 && (
        <div className="space-y-1.5 border-t border-zinc-800/70 p-3">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              onClick={() => {
                const el = document.querySelector<HTMLTextAreaElement>('textarea[data-copilot-input]');
                if (el) {
                  el.value = q;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
              }}
              className="w-full rounded-md border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-1.5 text-left text-[10.5px] text-zinc-400 transition hover:border-teal-800/60 hover:text-teal-200"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit(e);
        }}
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
                handleSubmit(e);
              }
            }}
          />
          {isLoading ? (
            <Button type="button" size="sm" variant="destructive" className="h-8 w-8 p-0" onClick={(e) => { e.preventDefault(); stop(); }}>
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button type="submit" size="sm" className="h-8 w-8 bg-teal-600/80 p-0 text-zinc-950 hover:bg-teal-500">
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[9px] text-zinc-600">
            agents: Trend Scout · Pattern Hawk · Macro Owl · Vol Oracle · Risk Quant · Strategy Smith
          </span>
          {messages.length > 0 && !isLoading && (
            <button type="button" onClick={() => reload()} className="text-[9px] text-zinc-500 underline hover:text-zinc-300">
              regenerate
            </button>
          )}
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

function EmptyState() {
  return (
    <div className="space-y-4 px-1 pt-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500/20 to-violet-500/20">
        <Sparkles className="h-7 w-7 text-teal-300" />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-zinc-200">VolOS Agentic Research Desk</p>
        <p className="mx-auto mt-1 max-w-[320px] text-[10.5px] leading-relaxed text-zinc-500">
          Six specialist agents — technical, chart, macro, volatility, profitability and strategy design —
          research live markets, stress-test likelihoods and build options strategies with you.
        </p>
      </div>
      <div className="mx-auto grid max-w-[320px] grid-cols-3 gap-1.5 text-[9.5px] text-zinc-500">
        {[
          ['📈', 'Trend Scout'],
          ['🕯️', 'Pattern Hawk'],
          ['🦉', 'Macro Owl'],
          ['🌊', 'Vol Oracle'],
          ['🎯', 'Risk Quant'],
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
