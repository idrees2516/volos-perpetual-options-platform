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

import { streamText, convertToCoreMessages } from 'ai';
import { zaiModel, ORCHESTRATOR_SYSTEM, dispatchAgentTool, loadStrategyTool } from '@/lib/ai/agents';
import { marketTools } from '@/lib/ai/agent-tools';
import { webIntelTools } from '@/lib/ai/web-intel-tools';
import { backquantTools, backquantSystemPrompt } from '@/lib/ai/backquant-tools';
import { renderCardTool } from '@/lib/cards/render-card-tool';
import { cardsSystemPrompt } from '@/lib/cards/catalog';
import { formatCopilotContext, type CopilotContextSnapshot } from '@/lib/copilot-context';

export const runtime = 'nodejs';
export const maxDuration = 300;

const WEB_RESEARCH_GUIDE = `
## Internet research (VolOS Alexandria)
You have WEB RESEARCH tools — research_web (search the options & derivatives industry web through a curated 40+ source catalog: Deribit Insights, Paradigm Research, Laevitas, Amberdata, CoinGlass, Velo, The Block, CBOE, education hubs…), scrape_page (deep-read any URL) and web_sources (show the source catalog). Use them when the question benefits from the wider internet: market sentiment & news (CPI/FOMC), IV outlooks, positioning commentary, how the industry constructs or manages positions, education deep-dives, or anything the in-platform feeds cannot know. Combine web intel with the platform's own live tools (get_market_state, analyze_volatility_regime, get_live_options_chain) — web for narrative/context, platform for exact numbers. Always attribute web findings with their source domain and include a ResearchDigest card with clickable sources via render_card.`;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      messages?: Array<{ role: string; content: string; parts?: unknown[] }>;
      context?: CopilotContextSnapshot | null;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // Ground the orchestrator in the user's live terminal context, the web
    // research guide, the BackQuant data layer and the generative-UI card
    // catalog vocabulary.
    const contextBlock = body.context ? formatCopilotContext(body.context) : '';
    const system = [
      ORCHESTRATOR_SYSTEM,
      WEB_RESEARCH_GUIDE,
      backquantSystemPrompt(),
      cardsSystemPrompt(),
      contextBlock,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = streamText({
      model: zaiModel,
      system,
      messages: convertToCoreMessages(messages as never),
      tools: {
        ...marketTools,
        ...webIntelTools,
        ...backquantTools,
        render_card: renderCardTool,
        dispatch_agent: dispatchAgentTool,
        load_strategy: loadStrategyTool,
      },
      maxSteps: 20,
      temperature: 0.4,
      onFinish: ({ usage }) => {
        console.log(
          `[copilot] finished · promptTokens=${usage.promptTokens} completionTokens=${usage.completionTokens}${
            body.context ? ` · ctx=${body.context.viewLabel}/${body.context.strategy.name}` : ''
          }`,
        );
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
