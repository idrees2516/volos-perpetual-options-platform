// Unit tests — the hybrid retrieval scorer (RAG core, pure): relevant
// memories outrank irrelevant ones, exact domain terms are rewarded, noise is
// cut by the threshold, and recency only breaks ties.

import { describe, expect, it } from 'vitest';
import { embedText } from './embeddings';
import { bm25, daysAgo, excerpt, MIN_SCORE, scoreMemories, type MemoryCandidate } from './retrieval';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

function cand(id: string, content: string, ageDays: number, role = 'assistant'): MemoryCandidate {
  return {
    id,
    sessionId: `s-${id}`,
    role,
    content,
    createdAt: NOW - ageDays * 86_400_000,
    embedding: embedText(content),
  };
}

describe('bm25', () => {
  it('rewards exact distinctive terms and ignores absent ones', () => {
    const docs = [
      ['bull', 'put', 'spread', 'btc', '94000'],
      ['funding', 'rate', 'hyperliquid', 'oi'],
      ['bull', 'put', 'spread', 'eth', '3500'],
    ];
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length;
    const q = ['bull', 'put', 'spread', '94000'];
    const s0 = bm25(q, docs[0], avg, df, 3);
    const s1 = bm25(q, docs[1], avg, df, 3);
    const s2 = bm25(q, docs[2], avg, df, 3);
    expect(s0).toBeGreaterThan(s2); // shares the phrase + has the rare 94000
    expect(s1).toBe(0); // zero overlap
  });
});

describe('scoreMemories', () => {
  it('ranks the on-topic memory first across cosine + BM25', () => {
    const cands = [
      cand('spread', 'You analyzed the BTC bull put spread at 94000: POP 68%, max loss capped at premium, invalidation at 96.2k.', 2),
      cand('funding', 'ETH funding flipped negative; Hyperliquid OI decayed 12% while CVD diverged.', 6),
      cand('fx', 'The quarterly roll cost on perps was 46bps annualized on Kraken.', 11),
    ];
    const hits = scoreMemories('what was the conclusion on the BTC bull put spread', embedText('what was the conclusion on the BTC bull put spread'), cands, NOW);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('spread');
  });

  it('cuts sub-threshold noise', () => {
    const cands = [cand('funding', 'ETH funding flipped negative overnight', 1)];
    const hits = scoreMemories('explain the gauss markov theorem', embedText('explain the gauss markov theorem'), cands, NOW);
    expect(hits).toHaveLength(0);
  });

  it('recency breaks ties but never beats relevance', () => {
    const old = cand('old', 'discussed the 0DTE iron fly on SOL with 74% POP', 25);
    const fresh = cand('fresh', 'reviewed Vega-neutral calendar spread thesis on SOL', 0.2);
    const hits = scoreMemories('0DTE iron fly SOL POP', embedText('0DTE iron fly SOL POP'), [old, fresh], NOW);
    expect(hits[0].id).toBe('old');
  });

  it('survives legacy rows without embeddings (lexical-only)', () => {
    const cands: MemoryCandidate[] = [
      { ...cand('legacy', 'the calendar spread on BTC expired worthless last month', 3), embedding: null },
    ];
    const hits = scoreMemories('calendar spread BTC', embedText('calendar spread BTC'), cands, NOW);
    expect(hits.length).toBe(1);
    expect(hits[0].score).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  it('labels when() buckets', () => {
    const hits = scoreMemories('anything', embedText('anything anything'), [cand('a', 'anything goes with numbers', 0.5)], NOW);
    expect(hits[0].when).toBe('today');
  });
});

describe('daysAgo / excerpt', () => {
  it('computes day distance', () => {
    expect(daysAgo(NOW - 86_400_000, NOW)).toBeCloseTo(1, 6);
    expect(daysAgo(NOW + 1000, NOW)).toBe(0); // future → clamped
  });

  it('truncates long content with an ellipsis, keeps short content exact', () => {
    expect(excerpt('short')).toBe('short');
    const long = 'x'.repeat(500);
    expect(excerpt(long)).toHaveLength(420);
    expect(excerpt(long).endsWith('…')).toBe(true);
    expect(excerpt('lots    of   whitespace', 999)).toBe('lots of whitespace');
  });
});
