// ---------------------------------------------------------------------------
// web-intel-tools — the Copilot's INTERNET RESEARCH toolbelt.
//
//   research_web   — search the options-industry web (Firecrawl Alexandria
//                    routing → domain-boosted search; z-ai fallback), returns
//                    normalized hits with source attribution
//   scrape_page    — deep-digest any URL into clean markdown
//   web_sources    — list the VolOS Alexandria industry source catalog
//                    (transparency + teaching: "where can you read for me?")
//
// These complete the desk's data story: venue feeds + pricing engine +
// backtester (all live in-platform) PLUS the open web — news wires,
// analytics desks, research shops, education hubs — pulled through the
// same agentic loop and rendered into json-render cards.
// ---------------------------------------------------------------------------

import { tool, jsonSchema } from 'ai';
import { researchWeb, scrapePage, webIntelProvider } from './web-intel';
import { alexandriaCatalogBrief, routeAlexandriaSources } from './alexandria-sources';

export const webIntelTools = {
  research_web: tool({
    description:
      "Search the OPTIONS & DERIVATIVES INDUSTRY WEB for current intelligence — news, analytics, research, market data — using the VolOS Alexandria source router (40+ curated industry sources: Deribit Insights, Paradigm Research, Laevitas, Amberdata, CoinGlass, Velo, The Block, CBOE, education hubs…). Returns real web hits with title, URL, snippet, domain, source attribution and the routed source list. Use it whenever the answer benefits from the wider internet: 'what's the market saying', IV sentiment, current events (CPI/FOMC), positioning commentary, strategy tutorials, comparing industry practice. Prefer this BEFORE advising on market regime or news-sensitive topics; combine with in-platform tools (get_market_state, analyze_volatility_regime) for ground truth numbers.",
    parameters: jsonSchema<{
      query: string;
      focus?: string;
      limit?: number;
    }>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Focused search query, e.g. "BTC options implied volatility outlook this week" or "how to build a defined-risk iron condor position management rules"',
        },
        focus: {
          type: 'string',
          enum: ['exchanges', 'market-data', 'analytics', 'research', 'news', 'education', 'macro', 'defi', 'traditional'],
          description: 'Industry focus — routes the query to the best sources for that need',
        },
        limit: { type: 'number', description: 'Hits to return, 1–10. Default 6.' },
      },
      required: ['query'],
    }),
    execute: async ({ query, focus, limit }) => {
      const r = await researchWeb(query, { focus, limit });
      return {
        provider: r.provider,
        query: r.query,
        routedSources: r.routedSources,
        hits: r.hits.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet,
          domain: h.domain,
          source: h.sourceName ?? h.sourceId ?? null,
          publishedDate: h.publishedDate ?? null,
        })),
        note: r.note,
        tsMs: r.tsMs,
      };
    },
  }),

  scrape_page: tool({
    description:
      'Deep-read ONE web page from a research_web hit (or any URL the user provides) into a clean text digest (~2.6k chars). Use it when a snippet is promising but you need the actual content — an IV analysis post, a strategy tutorial, a research piece — before summarizing or rendering cards from it.',
    parameters: jsonSchema<{ url: string }>({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to scrape' },
      },
      required: ['url'],
    }),
    execute: async ({ url }) => {
      const d = await scrapePage(url);
      return {
        url: d.url,
        title: d.title,
        provider: d.provider,
        chars: d.chars,
        content: d.markdown || '(page could not be read — rely on the search snippet instead)',
      };
    },
  }),

  web_sources: tool({
    description:
      "List the VolOS Alexandria industry source catalog — which options/derivatives data sources the desk can read on the internet (exchanges, market-data aggregators, analytics desks, research shops, news wires, education hubs, macro, DeFi, traditional index options), with each source's focus. Use it when the user asks 'where does your data come from', 'what can you research for me', or when choosing focus areas for research_web.",
    parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => ({
      engine: webIntelProvider(),
      engineNote:
        webIntelProvider() === 'firecrawl'
          ? 'Firecrawl Web Data API active: domain-boosted search, deep scrapes and Alexandria provider tools.'
          : 'Web search via the z-ai fallback engine (real internet results). Set FIRECRAWL_API_KEY to unlock full Firecrawl Alexandria.',
      sourceCount: alexandriaCatalogBrief().length,
      categories: [
        'exchanges — venue-native chains, IV, OI, flows, settlements',
        'market-data — cross-venue aggregators & vol surfaces',
        'analytics — greeks, skew, positioning, dealer exposure desks',
        'research — strategy research, papers, builder playbooks',
        'news — industry wires (events, CPI/FOMC, liquidations)',
        'education — position creation tutorials & Greeks literacy',
        'macro — rates, index vol, correlations',
        'defi — on-chain options protocols',
        'traditional — SPX/VIX index options industry',
      ],
      sources: alexandriaCatalogBrief(),
    }),
  }),
};

/** Routing preview for prompts (compact — teaches the model the geography). */
export function alexandriaRoutingPreview(query: string): string {
  const routed = routeAlexandriaSources(query, undefined, 5);
  return routed.map((s) => `${s.name} (${s.domain})`).join(' · ');
}
