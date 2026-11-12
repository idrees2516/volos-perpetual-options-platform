// ---------------------------------------------------------------------------
// embeddings — the memory layer's local vectorizer.
//
// A deterministic hashing vectorizer (the "hashing trick"): text → tokens
// (unigrams + bigrams) → FNV-1a hash → signed bucket in a fixed-dim float
// vector, sublinear-tf weighted, L2-normalized. Zero dependencies, zero
// network, instant, and stable across processes/restarts — which is exactly
// what a persisted conversation store needs (embeddings written months ago
// must still match queries today).
//
// Recall quality is carried by the hybrid retriever (retrieval.ts): this
// vector gives semantic-ish overlap smoothing, BM25 gives exact term
// matching (symbols, strikes, strategy names) — the combination is robust
// for domain-dense financial chat where distinctive vocabulary dominates.
// ---------------------------------------------------------------------------

export const EMBED_DIM = 384;

/** FNV-1a 32-bit hash of a string. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercase word tokens (len ≥ 2), numbers kept — "0dte", "94000", "iv".
 *  Thousands separators collapse first (94,000 → 94000) so a query written
 *  either way matches. */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/(\d),(\d{3})\b/g, '$1$2');
  return (normalized.match(/[a-z0-9][a-z0-9'+.-]{1,}/g) ?? []).map((t) =>
    t.replace(/^[.'-]+|[.'-]+$/g, ''),
  ).filter((t) => t.length >= 2);
}

/** Unigrams + bigrams — bigrams carry phrase structure ("gamma squeeze"). */
function features(text: string): string[] {
  const uni = tokenize(text);
  const bi: string[] = [];
  for (let i = 0; i + 1 < uni.length; i++) bi.push(`${uni[i]}_${uni[i + 1]}`);
  return [...uni, ...bi];
}

/** Deterministic local embedding of a text into EMBED_DIM dims. */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const counts = new Map<string, number>();
  for (const f of features(text)) counts.set(f, (counts.get(f) ?? 0) + 1);
  for (const [f, tf] of counts) {
    const h = fnv1a(f);
    const idx = h % EMBED_DIM;
    const sign = (h >>> 31) === 1 ? -1 : 1;
    vec[idx] += sign * (1 + Math.log(tf));
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity of two same-dim vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both are L2-normalized → dot IS the cosine
}

// --- persistence codec (base64-packed Float32Array ↔ string) ----------------

export function encodeEmbedding(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
}

export function decodeEmbedding(s: string): Float32Array | null {
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0 || buf.byteLength / 4 > EMBED_DIM * 2) return null;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } catch {
    return null;
  }
}
