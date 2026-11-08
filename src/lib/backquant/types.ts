// ---------------------------------------------------------------------------
// backquant/types — shared types for the BackQuant v2 integration.
//
// BackQuant (api.backquant.com/v2) is a professional crypto-options analytics
// API: 70 REST endpoints (GEX, chain, IV suite, probability, greeks + TRACE,
// OI & flow, liquidations, multi-venue options tape, market data, ETF flows,
// COT positioning, SEC filings) + a remote MCP server (mcp.backquant.com).
//
// VolOS integrates it at THREE layers:
//   1. REST client  — /api/backquant/* proxy (live when BACKQUANT_API_KEY is
//                     set, deterministic demo engine otherwise)
//   2. MCP          — VolOS is BOTH an MCP client (calls mcp.backquant.com)
//                     and an MCP server (exposes the same 23-tool catalog at
//                     /api/backquant/mcp for Claude / Cursor / any client)
//   3. Copilot      — the 23 BackQuant tools joined into the agentic toolbelt
// ---------------------------------------------------------------------------

/** Standard BackQuant v2 response meta block. */
export interface BqMeta {
  version: string;
  timestamp: string;
  request_id?: string;
  symbol?: string;
  spot_price?: number;
  computed_at?: string;
  freshness_seconds?: number;
  source?: string[];
  exchanges_filtered?: string[];
  rate_limit?: { limit?: string; remaining?: number; reset?: string };
  extra?: Record<string, unknown>;
}

/** Standard BackQuant v2 envelope: every REST response uses this shape. */
export interface BqEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  meta: BqMeta;
  /** VolOS extension: true when served by the built-in demo engine. */
  demo?: boolean;
}

/** How a request was actually served. */
export type BqMode = 'live' | 'demo';

/** Endpoint grouping — mirrors BackQuant's own documentation taxonomy. */
export type BqGroup =
  | 'discovery'
  | 'gex'
  | 'chain'
  | 'iv'
  | 'probability'
  | 'greeks'
  | 'oi'
  | 'tape'
  | 'liquidation'
  | 'market'
  | 'etf'
  | 'cot'
  | 'filings'
  | 'multi';

export interface BqGroupMeta {
  id: BqGroup;
  label: string;
  blurb: string;
}

/** A query parameter spec on a BackQuant endpoint. */
export interface BqParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'csv';
  required?: boolean;
  enumValues?: string[];
  default?: string | number | boolean;
  description?: string;
}

/** One registered v2 endpoint. Paths use `:param` for path segments. */
export interface BqEndpoint {
  id: string;
  /** Path pattern relative to /v2, e.g. '/gex/levels' or '/options/greeks/:greek'. */
  path: string;
  group: BqGroup;
  title: string;
  summary: string;
  params: BqParam[];
  /** In-process cache TTL for live calls (ms). */
  cacheTtlMs: number;
}

/** The compact MCP-style tool result every BackQuant tool returns. */
export interface BqToolResult {
  tool: string;
  summary: string;
  units?: string;
  as_of?: string;
  data_age_seconds?: number;
  venues?: string[];
  mode: BqMode;
  data: Record<string, unknown>;
}

/** Normalized option trade print (tape / whale / SSE stream). */
export interface BqTradePrint {
  ts: string;
  venue: string;
  symbol: string;
  instrument: string;
  option_type: 'call' | 'put';
  strike: number;
  expiry: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  premium_usd: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  aggressor?: 'buy' | 'sell';
  tags?: string[];
}

/** The 23 BackQuant MCP tools VolOS mirrors (catalog metadata). */
export interface BqMcpToolDoc {
  name: string;
  group: string;
  answers: string;
  args: string;
}
