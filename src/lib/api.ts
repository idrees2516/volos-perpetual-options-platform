// Rust engine API client. All requests route through the Caddy gateway
// using the XTransformPort query parameter — relative URLs only.

import type { Leg, MarketData, UnderlyingId } from './types';

const PORT = 3031;

function url(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}XTransformPort=${PORT}`;
}

export interface RustAnalysis {
  spot: number;
  atmIv30d: number;
  netPremium: number;
  maxProfit: { kind: string; value?: number; atPrice?: number };
  maxLoss: { kind: string; value?: number; atPrice?: number };
  breakevens: number[];
  pop: number;
  expectedValue: number;
  greeks: { delta: number; gamma: number; vega: number; theta: number; rho: number; deltaExposureUsd: number };
  marginEstimate: number;
  liquidity: number;
  diagnostics: { engine: string; computeUs: number; serverVersion: string };
}

export interface RustQuote {
  quoteId: string;
  strategyHash: string;
  theoreticalNet: number;
  settlement: string;
  computeUs: number;
  quotes: {
    maker: string;
    venue: string;
    netPrice: number;
    size: number;
    validSeconds: number;
    feeBps: number;
    improvementBps: number;
  }[];
}

export interface RustCandidate {
  name: string;
  thesis: string;
  legs: Leg[];
  category: string;
  maxLossClass: string;
  upsideClass: string;
  carryClass: string;
  ivExposure: string;
  liquidityClass: string;
  suggested: boolean;
}

export interface RustIntentResponse {
  underlying: string;
  spot: number;
  candidates: RustCandidate[];
  compileUs: number;
  notes: string[];
}

export interface RustChainRow {
  strike: number;
  callIv: number;
  callPrice: number;
  callDelta: number;
  callOi: number;
  callVolume: number;
  putIv: number;
  putPrice: number;
  putDelta: number;
  putOi: number;
  putVolume: number;
  isAtm: boolean;
}

export interface RustChain {
  underlying: string;
  expiryDays: number;
  spot: number;
  forward: number;
  atmIv: number;
  rows: RustChainRow[];
  computeUs: number;
}

export class EngineUnavailableError extends Error {
  constructor() {
    super('rust engine unreachable');
  }
}

async function fetchJson<T>(input: string, init?: RequestInit, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`engine ${res.status}: ${body.slice(0, 140)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export const engine = {
  health: () => fetchJson<{ status: string; engine: string; version: string }>(url('/api/v1/health'), undefined, 2500),

  snapshot: () => fetchJson<MarketData & { venueHealth: { name: string; status: string; latencyMs: number }[] }>(url('/api/v1/market/snapshot')),

  analyze: (req: { underlying: UnderlyingId; legs: Leg[]; size: number }) =>
    fetchJson<RustAnalysis>(url('/api/v1/strategy/analyze'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  quote: (req: { underlying: UnderlyingId; legs: Leg[]; size: number }) =>
    fetchJson<RustQuote>(url('/api/v1/strategy/quote'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  intent: (req: Record<string, unknown>) =>
    fetchJson<RustIntentResponse>(url('/api/v1/intent/compile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  chain: (underlying: UnderlyingId, expiryDays: number) =>
    fetchJson<RustChain>(url(`/api/v1/options/chain?underlying=${underlying}&expiry_days=${expiryDays}`)),
};

/** Open an SSE stream to the Rust market simulator. Returns a closer. */
export function openMarketStream(onData: (m: MarketData) => void, onError: () => void): () => void {
  const es = new EventSource(url('/api/v1/market/stream'));
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as MarketData;
      onData({ ...data, source: 'rust' });
    } catch {
      /* ignore malformed frames */
    }
  };
  es.onerror = () => {
    onError();
  };
  return () => es.close();
}
