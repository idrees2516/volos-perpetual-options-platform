// ---------------------------------------------------------------------------
// retrieval — the RAG scoring core (pure, no I/O → unit tested).
//
// Hybrid scoring = 0.55 × cosine(embeddings) + 0.45 × BM25(max-normalized):
//   • cosine smooths vocabulary overlap (asks about "premium" → recalls
//     "net premium" turns)
//   • BM25 nails exact distinctive tokens ("94000 strike", "0dte",
//     "bull put spread") with length normalization
// Recency is a small additive tiebreaker, never the driver — a highly
// relevant turn from three weeks ago must outrank a weak hit from an hour
// ago, but among equals the fresher memory wins.
// ---------------------------------------------------------------------------

import { cosine, tokenize } from './embeddings';

export interface MemoryCandidate {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: Date | number;
  /** decoded embedding (null for legacy rows → lexical only). */
  embedding: Float32Array | null;
}

export interface ScoredMemory {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: Date | number;
  score: number;
  when: string;
}

const COSINE_WEIGHT = 0.55;
const BM25_WEIGHT = 0.45;
const RECENCY_BONUS_MAX = 0.04; // tiny tiebreaker over a 30-day window
/** Below this hybrid score a hit is noise — better no memory than fake memory. */
export const MIN_SCORE = 0.12;

export function daysAgo(createdAt: Date | number, now: number): number {
  const t = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  return Math.max(0, (now - t) / 86_400_000);
}

/** BM25 (k1=1.4, b=0.65) of query terms against one document. */
export function bm25(
  queryTerms: string[],
  docTerms: string[],
  avgDocLen: number,
  df: Map<string, number>,
  docCount: number,
): number {
  if (queryTerms.length === 0 || docTerms.length === 0 || avgDocLen === 0 || docCount === 0) return 0;
  const k1 = 1.4;
  const b = 0.65;
  const tf = new Map<string, number>();
  for (const t of docTerms) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of new Set(queryTerms)) {
    const f = tf.get(term);
    if (!f) continue;
    const n = df.get(term) ?? 0;
    const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docTerms.length) / avgDocLen)));
  }
  return score;
}

/**
 * Rank candidates for a query: the caller embeds the query once (embedText)
 * and passes it in — keeps this module pure and import-light.
 */
export function scoreMemories(
  query: string,
  queryVec: Float32Array,
  candidates: MemoryCandidate[],
  now = Date.now(),
): ScoredMemory[] {
  const queryTerms = tokenize(query);
  const docs = candidates.map((c) => tokenize(c.content));
  const avgDocLen = docs.length > 0 ? docs.reduce((s, d) => s + d.length, 0) / docs.length : 0;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  const rawLexical = candidates.map((_, i) => bm25(queryTerms, docs[i], avgDocLen, df, candidates.length));
  const maxLexical = Math.max(...rawLexical, 1e-9);

  const scored: ScoredMemory[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cos = c.embedding ? Math.max(0, cosine(queryVec, c.embedding)) : 0;
    const lexical = rawLexical[i] / maxLexical; // → [0,1]
    const ageDays = daysAgo(c.createdAt, now);
    const recency = Math.max(0, RECENCY_BONUS_MAX * (1 - Math.min(ageDays, 30) / 30));
    const score = COSINE_WEIGHT * cos + BM25_WEIGHT * lexical + recency;
    if (score < MIN_SCORE) continue;
    scored.push({
      id: c.id,
      sessionId: c.sessionId,
      role: c.role,
      content: c.content,
      createdAt: c.createdAt,
      score,
      when: ageDays < 1 ? 'today' : `${Math.floor(ageDays)}d ago`,
    });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** Collapse a user/assistant message into a compact prompt excerpt. */
export function excerpt(text: string, maxChars = 420): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}
