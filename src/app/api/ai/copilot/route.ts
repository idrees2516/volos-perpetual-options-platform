// POST /api/ai/copilot — the interactive Research Director chat endpoint.
// Vercel AI SDK streamText with the full desk toolbelt (market tools +
// agent dispatch + strategy loading + INTERNET RESEARCH via the VolOS
// Alexandria web-intel engine + generative-UI cards via @json-render),
// multi-step agentic loop, streamed to the frontend as an AI SDK data stream
// consumed by useChat().
//
// CONTEXT-GROUNDED: the frontend ships a live terminal context snapshot
// (active workspace, selected strategy + legs, live exchange prices) with
// every request; it is injected into the system prompt so every copilot
// answer is based on the data the platform is actually pulling.
//
// MEMORY-GROUNDED (RAG): the frontend ships a persistent sessionId; the
// turn is persisted on finish (SQLite), and each request begins with
//   • a restored history block for the CURRENT session (survives reloads),
//   • auto-retrieved relevant exchanges from ALL past sessions (hybrid
//     embedding-cosine + BM25 recall) injected as "Conversation memory".
// The model can dig deeper at runtime via the memory_search tool.
//
// MODEL-ROUTED: the backend is OmniRoute (or any OpenAI-compatible gateway)
// when configured, with automatic failover to the in-sandbox GLM backend.

import { streamText, convertToCoreMessages } from 'ai';
import { deskModel, ORCHESTRATOR_SYSTEM, dispatchAgentTool, loadStrategyTool } from '@/lib/ai/agents';
import { marketTools } from '@/lib/ai/agent-tools';
import { webIntelTools } from '@/lib/ai/web-intel-tools';
import { quantTools, quantSystemPrompt } from '@/lib/ai/quant-tools';
import { positionsTools, positionsSystemPrompt } from '@/lib/ai/positions-tools';
import { autopilotTools, autopilotSystemPrompt } from '@/lib/ai/autopilot-tools';
import { renderCardTool } from '@/lib/cards/render-card-tool';
import { cardsSystemPrompt } from '@/lib/cards/catalog';
import { formatCopilotContext, type CopilotContextSnapshot } from '@/lib/copilot-context';
import { memoryTools } from '@/lib/ai/memory/memory-tools';
import { recall, saveTurn, sessionHistory, formatMemoryBlock } from '@/lib/ai/memory/store';
import { excerpt } from '@/lib/ai/memory/retrieval';

export const runtime = 'nodejs';
export const maxDuration = 300;

const WEB_RESEARCH_GUIDE = `
## Internet research (VolOS Alexandria)
You have WEB RESEARCH tools — research_web (search the options & derivatives industry web through a curated 40+ source catalog: Deribit Insights, Paradigm Research, Laevitas, Amberdata, CoinGlass, Velo, The Block, CBOE, education hubs…), scrape_page (deep-read any URL) and web_sources (show the source catalog). Use them when the question benefits from the wider internet: market sentiment & news (CPI/FOMC), IV outlooks, positioning commentary, how the industry constructs or manages positions, education deep-dives, or anything the in-platform feeds cannot know. Combine web intel with the platform's own live tools (get_market_state, analyze_volatility_regime, get_live_options_chain) — web for narrative/context, platform for exact numbers. Always attribute web findings with their source domain and include a ResearchDigest card with clickable sources via render_card.`;

/** Extract plain text from a frontend chat message (string or parts array). */
function messageText(m: { content?: unknown; parts?: unknown } | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.parts)) {
    return (m.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/** The session-restore block: the current thread's persisted tail, so a
 *  reload (empty useChat state) still carries the thread's continuity. */
function formatRestoredHistory(
  rows: Array<{ role: string; content: string; createdAt: Date }>,
): string {
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const who = r.role === 'user' ? 'User' : 'You';
    const when = new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    return `[${when} UTC] ${who}: ${excerpt(r.content, 300)}`;
  });
  return `## Session history (restored from memory)
The current chat thread was restored after a reload — this is what was said (do not repeat it back, just continue naturally from it):
${lines.join('\n')}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      messages?: Array<{ role: string; content?: string; parts?: unknown }>;
      context?: CopilotContextSnapshot | null;
      sessionId?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 64
        ? body.sessionId
        : `anon-${Date.now().toString(36)}`;

    // --- memory retrieval (RAG) ---------------------------------------------
    // Query = the latest user message; candidates exclude the current session
    // (already present in the message list / restored block below).
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastUserText = messageText(lastUser);
    const [memoryHits, restored] = await Promise.all([
      lastUserText ? recall(lastUserText, { k: 6, excludeSessionId: sessionId }) : Promise.resolve([]),
      // only restore when the browser state is cold (single in-flight turn)
      messages.filter((m) => m.role === 'user').length <= 1 ? sessionHistory(sessionId, 12) : Promise.resolve([]),
    ]);
    const memoryBlock = formatMemoryBlock(memoryHits);
    const restoredBlock = formatRestoredHistory(restored);

    // Ground the orchestrator in the user's live terminal context, the web
    // research guide, the native VolQuant data layer, the conversation
    // memory and the generative-UI card catalog vocabulary.
    const contextBlock = body.context ? formatCopilotContext(body.context) : '';
    const system = [
      ORCHESTRATOR_SYSTEM,
      WEB_RESEARCH_GUIDE,
      quantSystemPrompt(),
      positionsSystemPrompt(),
      autopilotSystemPrompt(),
      cardsSystemPrompt(),
      memoryBlock,
      restoredBlock,
      contextBlock,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = streamText({
      model: deskModel,
      system,
      messages: convertToCoreMessages(messages as never),
      tools: {
        ...marketTools,
        ...webIntelTools,
        ...quantTools,
        ...positionsTools,
        ...autopilotTools,
        ...memoryTools,
        render_card: renderCardTool,
        dispatch_agent: dispatchAgentTool,
        load_strategy: loadStrategyTool,
      },
      maxSteps: 20,
      temperature: 0.4,
      onFinish: ({ usage, text }) => {
        console.log(
          `[copilot] finished · promptTokens=${usage.promptTokens} completionTokens=${usage.completionTokens}` +
            `${body.context ? ` · ctx=${body.context.viewLabel}/${body.context.strategy.name}` : ''}` +
            ` · memory=${memoryHits.length} hits · restored=${restored.length} turns`,
        );
        // Persist the turn (fire-and-forget, error-swallowing).
        void saveTurn({ sessionId, userText: lastUserText, assistantText: text });
      },
    });

    return result.toDataStreamResponse({
      headers: {
        'X-Agentic-Desk': 'volos-research',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    console.error('[copilot] error:', err);
    return new Response(JSON.stringify({ error: 'copilot unavailable' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
