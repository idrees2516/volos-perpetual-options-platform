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
  health: () => fetchJson<{ status: string; engine: string; version: string; strategies: number; maxLegs: number }>(url('/api/v1/health'), undefined, 2500),

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

  // ---------------- strategy catalog (118 strategies, <=25 legs) ----------------

  strategies: () =>
    fetchJson<{
      total: number;
      maxLegs: number;
      categories: [string, number][];
      legHistogram: [number, number][];
      strategies: {
        id: string;
        name: string;
        category: string;
        view: string;
        complexity: number;
        description: string;
        tags: string[];
        legs: { kind: string; side: string; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }[];
      }[];
    }>(url('/api/v1/strategies')),

  resolveStrategy: (id: string, underlying: UnderlyingId) =>
    fetchJson<{
      strategy: { id: string; name: string; category: string; view: string; complexity: number; description: string; tags: string[] };
      underlying: string;
      spot: number;
      step: number;
      legs: {
        kind: Leg['kind'];
        side: Leg['side'];
        qty: number;
        strike?: number;
        expiryDays?: number;
        fundingPeriodDays?: number;
        instrument: string;
        theo: number;
      }[];
    }>(url(`/api/v1/strategies/${id}/resolve?underlying=${underlying}`)),

  // ---------------- CLOB trading engine ----------------

  tradingState: () =>
    fetchJson<TradingState>(url('/api/v1/trading/state'), undefined, 8000),

  book: (instrument: string, depth = 12) =>
    fetchJson<BookResponse>(url(`/api/v1/trading/book?instrument=${encodeURIComponent(instrument)}&depth=${depth}`)),

  placeOrder: (req: PlaceOrderReq) =>
    fetchJson<EngineOrder>(url('/api/v1/trading/order'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  amendOrder: (req: { orderId: number; price?: number; qty?: number }) =>
    fetchJson<EngineOrder>(url('/api/v1/trading/order/amend'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  cancelOrder: (orderId: number) =>
    fetchJson<EngineOrder>(url('/api/v1/trading/order/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    }),

  cancelAll: (instrument?: string) =>
    fetchJson<{ canceled: number }>(url('/api/v1/trading/order/cancel-all'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(instrument ? { instrument } : {}),
    }),

  orders: () => fetchJson<EngineOrder[]>(url('/api/v1/trading/orders')),

  tape: (instrument?: string) =>
    fetchJson<EngineTrade[]>(
      url(`/api/v1/trading/tape?limit=120${instrument ? `&instrument=${encodeURIComponent(instrument)}` : ''}`),
    ),

  // ---------------- strategy RFQ (up to 25 legs) ----------------

  rfqCreate: (req: { underlying: UnderlyingId; legs: Leg[]; side: 'buy' | 'sell'; size: number }) =>
    fetchJson<RfqSession>(url('/api/v1/rfq'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  rfqGet: (id: number) => fetchJson<RfqSession>(url(`/api/v1/rfq/${id}`)),

  rfqExecute: (id: number, dealer: string) =>
    fetchJson<{ execution: { dealer: string; venue: string; price: number; fee: number; filledMs: number; hedge: RouteChild[]; hedgeVwap: number }; hedgeRoute: RoutePlan; positionApplied: number }>(
      url(`/api/v1/rfq/${id}/execute`),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dealer }) },
    ),

  rfqCancel: (id: number) =>
    fetchJson<{ cancelled: number }>(url(`/api/v1/rfq/${id}/cancel`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),

  // ---------------- venues + smart order router ----------------

  venues: () => fetchJson<VenueStatus[]>(url('/api/v1/venues')),

  venueQuotes: (instrument?: string) =>
    fetchJson<VenueQuote[]>(
      url(`/api/v1/venues/quotes${instrument ? `?instrument=${encodeURIComponent(instrument)}` : ''}`),
    ),

  routePlan: (req: { instrument: string; side: 'buy' | 'sell'; qty: number }) =>
    fetchJson<RoutePlan>(url('/api/v1/venues/route'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  // ---------------- risk + fees ----------------

  risk: () =>
    fetchJson<RiskSummary>(url('/api/v1/risk')),

  fees: () =>
    fetchJson<FeeSchedule>(url('/api/v1/fees')),
};

// ---------------- trading DTOs (mirror the Rust engine) ----------------

export interface EngineOrder {
  id: number;
  account: string;
  instrument: string;
  side: 'buy' | 'sell';
  kind: 'limit' | 'market' | 'post_only' | 'ioc' | 'fok' | 'stop_market' | 'stop_limit';
  status: 'pending' | 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired';
  priceTicks?: number;
  triggerTicks?: number;
  lots: number;
  filledLots: number;
  avgFillPrice: number;
  stp: string;
  seq: number;
  tsMs: number;
  updateMs: number;
  reject?: string;
}

export interface EngineTrade {
  id: number;
  instrument: string;
  price: number;
  qty: number;
  takerSide: 'buy' | 'sell';
  maker: string;
  taker: string;
  takerFee: number;
  makerRebate: number;
  tsMs: number;
}

export interface L1Dto {
  instrument: string;
  underlying: string;
  kind: 'perp_future' | 'perp_option' | 'dated_option';
  strike?: number;
  optType?: string;
  theo: number;
  mark: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  last?: number;
}

export interface TradingState {
  serverMs: number;
  account: {
    id: string;
    balance: number;
    equity: number;
    unrealizedPnl: number;
    feesPaid: number;
    fundingPaid: number;
    marginUsed: number;
    marginRatio: number;
    openOrders: number;
  };
  l1: L1Dto[];
  positions: {
    instrument: string;
    underlying: string;
    kind: string;
    qty: number;
    avgCost: number;
    mark: number;
    value: number;
    unrealizedPnl: number;
    realizedPnl: number;
  }[];
  greeks: {
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
    deltaUsd: number;
    perUnderlying: Record<string, { delta: number; gamma: number; vega: number; theta: number }>;
  };
  venues: VenueStatus[];
  strategyCount: number;
  maxLegs: number;
}

export interface VenueStatus {
  venue: string;
  mode: string;
  status: string;
  latencyMs: number;
  detail: string;
}

export interface VenueQuote {
  venue: string;
  mode: string;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
  feeBps: number;
  latencyMs: number;
}

export interface RouteChild {
  venue: string;
  price: number;
  qty: number;
  feeBps: number;
  latencyMs: number;
  ownClob: boolean;
}

export interface RoutePlan {
  instrument: string;
  side: 'buy' | 'sell';
  requestedQty: number;
  plannedQty: number;
  children: RouteChild[];
  vwap: number;
  worstSingleVenue: number;
  bestSingleVenue: number;
  savingsBps: number;
  feeTotal: number;
}

export interface BookResponse {
  instrument: string;
  l2: { instrument: string; bids: { price: number; qty: number; orders: number }[]; asks: { price: number; qty: number; orders: number }[]; seq: number };
  l3: { orderId: number; side: 'buy' | 'sell'; price: number; qty: number; tsMs: number }[];
  theo: number;
  mark: number;
  last?: number;
}

export interface FirmQuoteDto {
  dealer: string;
  venue: string;
  seq: number;
  price: number;
  size: number;
  feeBps: number;
  edgeBps: number;
  inventorySkewBps: number;
  issuedMs: number;
  arrivedMs: number;
  validUntilMs: number;
  status: 'pending' | 'live' | 'expired' | 'pulled' | 'filled';
  issuedTheo: number;
}

export interface RfqSession {
  id: number;
  underlying: string;
  legs: { kind: string; side: string; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }[];
  side: 'buy' | 'sell';
  size: number;
  state: 'quoting' | 'executed' | 'expired' | 'cancelled';
  createdMs: number;
  expiresMs: number;
  theo: number;
  packageDelta: number;
  quotes: FirmQuoteDto[];
  execution?: {
    dealer: string;
    venue: string;
    price: number;
    fee: number;
    filledMs: number;
    hedge: RouteChild[];
    hedgeVwap: number;
  };
  strategyHash: string;
}

export interface RiskSummary {
  equity: number;
  balance: number;
  marginUsed: number;
  marginRatio: number;
  maintenanceRatio: number;
  healthy: boolean;
  greeks: TradingState['greeks'];
  limits: { maxPositionAbs: number; maxOrderNotional: number; maxOpenOrders: number };
}

export interface FeeSchedule {
  takerFeeBps: number;
  makerRebateBps: number;
  inventorySkew: number;
  marginBuffer: number;
  maintenanceRatio: number;
  collateralCurrencies: string[];
  venues: { venue: string; takerFeeBps: number; makerRebateBps: number; settlement: string }[];
  notes: string[];
}

export interface PlaceOrderReq {
  instrument: string;
  side: 'buy' | 'sell';
  kind: 'limit' | 'market' | 'post_only' | 'ioc' | 'fok' | 'stop_market' | 'stop_limit';
  price?: number;
  trigger?: number;
  qty: number;
  stp?: 'cancel_newest' | 'cancel_oldest' | 'decrement';
  account?: string;
}

export type EngineEvent =
  | { type: 'l1_all'; data: L1Dto[] }
  | { type: 'trades'; data: EngineTrade[] }
  | { type: 'orders'; data: EngineOrder[] }
  | { type: 'account'; id: string }
  | { type: 'rfq'; id: number };

/** Open the SSE stream to the trading engine (L1/fills/orders/RFQ events). */
export function openTradingStream(
  onEvent: (ev: EngineEvent) => void,
  onError: () => void,
): () => void {
  const es = new EventSource(url('/api/v1/trading/stream'));
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as EngineEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  es.onerror = () => onError();
  return () => es.close();
}

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
