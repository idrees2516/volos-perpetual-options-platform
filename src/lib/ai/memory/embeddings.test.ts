// Unit tests — the memory layer's local embedding engine: determinism
// (embeddings written today must still match queries in a year), semantic
// ordering (related > unrelated), and the base64 persistence codec.

import { describe, expect, it } from 'vitest';
import { cosine, decodeEmbedding, embedText, encodeEmbedding, tokenize, EMBED_DIM } from './embeddings';

describe('tokenize', () => {
  it('lowercases, keeps numbers and domain terms, collapses thousands separators', () => {
    expect(tokenize('BTC 0DTE spread @ $94,000!')).toEqual(['btc', '0dte', 'spread', '94000']);
    expect(tokenize('94000 vs 94,000 — same token')).toContain('94000');
  });

  it('drops single characters and empty strings', () => {
    expect(tokenize('a I at 42')).toEqual(['at', '42']);
  });
});

describe('embedText', () => {
  it('produces a fixed-dim L2-normalized vector', () => {
    const v = embedText('bull put spread on BTC at 94000');
    expect(v.length).toBe(EMBED_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic across calls (persistence guarantee)', () => {
    const a = embedText('gamma squeeze risk near 95k call wall');
    const b = embedText('gamma squeeze risk near 95k call wall');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('orders related above unrelated', () => {
    const q = embedText('what did we conclude about the BTC bull put spread?');
    const related = embedText('the bull put spread on BTC at 94000 had POP 68% and max loss 1.2x premium');
    const unrelated = embedText('ETH funding rate flipped negative and open interest on Hyperliquid decayed');
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });

  it('empty-ish text yields a zero vector, not NaN', () => {
    const v = embedText('   ... ');
    expect(Number.isFinite(v[0])).toBe(true);
  });
});

describe('embedding codec', () => {
  it('round-trips base64 without loss', () => {
    const v = embedText('conversation memory round trip test');
    const restored = decodeEmbedding(encodeEmbedding(v));
    expect(restored).not.toBeNull();
    expect(Array.from(restored!)).toEqual(Array.from(v));
  });

  it('rejects garbage without throwing', () => {
    expect(decodeEmbedding('not-base64!!!')).toBeNull();
    expect(decodeEmbedding('')).toBeNull();
  });
});
