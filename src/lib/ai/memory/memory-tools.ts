// ---------------------------------------------------------------------------
// memory-tools — the copilot's introspective memory tools.
//
//   • memory_search: semantic + lexical search over ALL past conversations
//     (cross-session) — the model digs for prior conclusions on demand.
//   • memory_stats: how much the desk remembers (sessions, messages, age).
//
// Both are read-only, error-swallowing (a memory outage must never break a
// turn) and return compact JSON the orchestrator can reason over.
// ---------------------------------------------------------------------------

import { tool, jsonSchema } from 'ai';
import { recall, memoryStats } from './store';
import { excerpt } from './retrieval';

export const memoryTools = {
  memory_search: tool({
    description:
      "Search the desk's LONG-TERM conversation memory (all past sessions, persisted history). Use it when the current question refers to something discussed earlier ('that spread we talked about', 'the BTC thesis from last week', 'what did the research conclude') or when continuity matters. Returns the most relevant past exchanges with dates.",
    parameters: jsonSchema<{ query: string; k?: number }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for — a topic, strategy, asset or question phrased naturally, e.g. "bull put spread BTC 0dte conclusion".' },
        k: { type: 'number', description: 'How many hits to return (default 6, max 12).' },
      },
      required: ['query'],
    }),
    execute: async ({ query, k }) => {
      const hits = await recall(query, { k: Math.min(Math.max(1, k ?? 6), 12) });
      if (hits.length === 0) {
        return { found: false, note: 'No relevant past exchanges in memory yet.' };
      }
      return {
        found: true,
        hits: hits.map((h) => ({
          when: h.when,
          role: h.role,
          relevance: Math.round(h.score * 100) / 100,
          excerpt: excerpt(h.content, 600),
        })),
      };
    },
  }),

  memory_stats: tool({
    description:
      'How much the desk currently remembers: number of conversation sessions, persisted messages and how far back the memory reaches. Use it when the user asks about memory itself.',
    parameters: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
    }),
    execute: async () => {
      const stats = await memoryStats();
      return {
        ...stats,
        note: 'Every copilot turn and deep-research dossier is persisted; recall is hybrid (embedding cosine + BM25) over the last 180 days.',
      };
    },
  }),
};
