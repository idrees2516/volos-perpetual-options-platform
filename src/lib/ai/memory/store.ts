// ---------------------------------------------------------------------------
// store — conversation memory persistence + recall (the RAG substrate).
//
// "Store now, remember later": every copilot turn and every deep-research
// dossier is written to SQLite (ConversationSession / ConversationMessage)
// with a precomputed local embedding. On each new request the latest user
// message is embedded and the hybrid retriever (retrieval.ts) pulls the
// most relevant past turns — across ALL sessions, not just the current
// chat — which get injected into the system prompt as "## Conversation
// memory". A memory_search tool lets the model dig deeper on demand.
//
// Failure contract mirrors writer.ts: every function swallows its own
// errors — memory is an enhancement and must never take the desk down.
// ---------------------------------------------------------------------------

import { db } from '@/lib/db';
import { embedText, encodeEmbedding, decodeEmbedding } from './embeddings';
import { scoreMemories, excerpt, type ScoredMemory } from './retrieval';

/** How far back the recall window reaches. */
const RECALL_WINDOW_DAYS = 180;
/** Max candidate rows scored per query (recency-capped before scoring). */
const RECALL_CANDIDATE_CAP = 1500;
/** Conversation memory is long-lived by design. */
const RETENTION_DAYS = 730;
const PRUNE_INTERVAL_MS = 3600_000;

let lastPrune = 0;

/** A recalled past exchange, ranked by the hybrid retriever. */
export type MemoryHit = ScoredMemory;

function tokensOf(text: string): number {
  return Math.ceil(text.length / 3.6);
}

async function prune(): Promise<void> {
  if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = Date.now();
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    await db.conversationMessage.deleteMany({ where: { createdAt: { lt: cutoff } } });
    // drop sessions that ended up with no messages
    await db.conversationSession.deleteMany({ where: { messages: { none: {} } } });
  } catch {
    /* best-effort */
  }
}

/** Upsert the session row (title = first user message, truncated). */
export async function ensureSession(sessionId: string, kind: 'chat' | 'research', title: string): Promise<void> {
  try {
    await db.conversationSession.upsert({
      where: { id: sessionId },
      create: { id: sessionId, kind, title: title.slice(0, 120) },
      update: { updatedAt: new Date() },
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Persist one copilot turn: the user's question + the desk's answer, both
 * embedded. Called from the copilot route's onFinish (fire-and-forget).
 */
export async function saveTurn(input: {
  sessionId: string;
  userText: string;
  assistantText: string;
  kind?: 'chat' | 'research';
}): Promise<void> {
  try {
    await prune();
    const kind = input.kind ?? 'chat';
    await ensureSession(input.sessionId, kind, input.userText);
    const rows: Array<{ role: string; content: string; embedding: string; tokens: number }> = [];
    if (input.userText.trim().length > 0) {
      rows.push({
        role: 'user',
        content: input.userText.slice(0, 20_000),
        embedding: encodeEmbedding(embedText(input.userText)),
        tokens: tokensOf(input.userText),
      });
    }
    if (input.assistantText.trim().length > 0) {
      rows.push({
        role: 'assistant',
        content: input.assistantText.slice(0, 20_000),
        embedding: encodeEmbedding(embedText(input.assistantText)),
        tokens: tokensOf(input.assistantText),
      });
    }
    if (rows.length > 0) {
      await db.conversationMessage.createMany({ data: rows.map((r) => ({ ...r, sessionId: input.sessionId })) });
      await db.conversationSession.update({ where: { id: input.sessionId }, data: { updatedAt: new Date() } });
    }
  } catch (err) {
    console.warn('[memory] saveTurn failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Persist a deep-research dossier as a single memorable unit (the report is
 * the thing later conversations will want to recall).
 */
export async function saveResearchReport(input: {
  sessionId: string;
  asset: string;
  focus: string;
  report: string;
}): Promise<void> {
  try {
    await ensureSession(input.sessionId, 'research', `Deep research · ${input.asset} · ${input.focus}`);
    const content = input.report.slice(0, 40_000);
    await db.conversationMessage.create({
      data: {
        sessionId: input.sessionId,
        role: 'research',
        content,
        embedding: encodeEmbedding(embedText(`${input.asset} ${input.focus}\n${content}`)),
        tokens: tokensOf(content),
      },
    });
  } catch (err) {
    console.warn('[memory] saveResearchReport failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * RAG recall: embed the query, fetch the recent-window candidate rows,
 * hybrid-score them, return the top-k hits (most relevant first).
 * Optionally exclude the current session so only CROSS-session memory is
 * surfaced (the current session is already in the message list).
 */
export async function recall(
  query: string,
  opts: { k?: number; excludeSessionId?: string; now?: number } = {},
): Promise<MemoryHit[]> {
  const k = opts.k ?? 6;
  try {
    const since = new Date(Date.now() - RECALL_WINDOW_DAYS * 86_400_000);
    const rows = await db.conversationMessage.findMany({
      where: {
        createdAt: { gte: since },
        ...(opts.excludeSessionId ? { sessionId: { not: opts.excludeSessionId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: RECALL_CANDIDATE_CAP,
      select: { id: true, sessionId: true, role: true, content: true, createdAt: true, embedding: true },
    });
    if (rows.length === 0) return [];
    const queryVec = embedText(query);
    const candidates = rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt,
      embedding: r.embedding ? decodeEmbedding(r.embedding) : null,
    }));
    return scoreMemories(query, queryVec, candidates, opts.now ?? Date.now()).slice(0, k);
  } catch (err) {
    console.warn('[memory] recall failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** The last turns of one session — restores a chat after a page reload. */
export async function sessionHistory(sessionId: string, limit = 12): Promise<
  Array<{ role: string; content: string; createdAt: Date }>
> {
  try {
    const rows = await db.conversationMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true, content: true, createdAt: true },
    });
    return rows.reverse();
  } catch {
    return [];
  }
}

/** Counters for the provider status badge. */
export async function memoryStats(): Promise<{ sessions: number; messages: number; oldestDays?: number }> {
  try {
    const sessions = await db.conversationSession.count();
    const messages = await db.conversationMessage.count();
    let oldestDays: number | undefined;
    if (messages > 0) {
      const oldest = await db.conversationMessage.findFirst({ orderBy: { createdAt: 'asc' } });
      if (oldest) oldestDays = Math.round((Date.now() - oldest.createdAt.getTime()) / 86_400_000);
    }
    return { sessions, messages, oldestDays };
  } catch {
    return { sessions: 0, messages: 0 };
  }
}

/** Format recalled hits into the system-prompt memory block. */
export function formatMemoryBlock(hits: MemoryHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    const who = h.role === 'user' ? 'the user asked' : h.role === 'research' ? 'deep research concluded' : 'you answered';
    return `${i + 1}. (${h.when}) ${who}: "${excerpt(h.content)}"`;
  });
  return `## Conversation memory — relevant past exchanges (auto-retrieved)
You have LONG-TERM MEMORY of this desk's conversation history. Below are the most relevant past exchanges for the current question — earlier conclusions you and the user reached, strategies you discussed, numbers you quoted. Use them for continuity: reference prior decisions instead of re-deriving them, follow up on threads the user left open. Use memory_search to dig deeper when something feels half-remembered.
${lines.join('\n')}`;
}
