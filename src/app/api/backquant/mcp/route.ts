// POST /api/backquant/mcp — the VolOS-hosted BackQuant MCP SERVER.
//
// A Streamable-HTTP Model Context Protocol server (JSON-RPC 2.0) exposing the
// same 23 tools as mcp.backquant.com, executed on VolOS's data plane:
//   • LIVE  — real BackQuant v2 REST when BACKQUANT_API_KEY is set
//   • DEMO  — the deterministic BackQuant-compatible demo engine otherwise
//
// Point any MCP client at it (Claude / Cursor / VS Code custom connector):
//   { "mcpServers": { "volos-backquant": { "url": "http://localhost:3000/api/backquant/mcp" } } }
//
// Supported methods: initialize · notifications/initialized · tools/list ·
// tools/call · ping. Stateless sessions (Streamable HTTP allows it); every
// tools/call result carries the BackQuant tool contract
// (summary / units / as_of / data_age_seconds / venues / mode).

import { runBackQuantTool, BQ_MCP_TOOLS } from '@/lib/backquant/mcp';
import { bqMode, BQ_BASE_URL, BQ_MCP_URL } from '@/lib/backquant/client';
import { BQ_ENDPOINT_COUNT } from '@/lib/backquant/endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'volos-backquant', version: '1.0.0' };

// ── input schemas for the 23 tools (mirrors the remote server) ──────────────

const S = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: props,
  ...(required.length ? { required } : {}),
});
const symProp = { type: 'string', description: 'Underlying symbol: BTC, ETH or SOL (BTCUSDT/ETHUSDT/SOLUSDT)' };
const posProp = { type: 'string', enum: ['flow', 'std'], description: 'Dealer positioning model (default flow)' };
const expiryProp = { type: 'string', description: 'Expiry token (e.g. 2026-11-14), or "next" / "0dte" / "all"' };

const TOOL_SCHEMAS: Record<string, { schema: Record<string, unknown>; description: string }> = {
  get_brief: {
    description: 'Everything at once for one market: price against the dealer-gamma levels, perpetual positioning, and what the options tape has been doing. Best first move for an open question.',
    schema: S({ symbol: symProp }),
  },
  get_gex_levels: {
    description: 'Gamma flip (HVL), call wall, put support for a market — all-expiry and 0DTE, with ranked largest-GEX strikes, max pain and expected move.',
    schema: S({ symbol: symProp, positioning: posProp }),
  },
  get_gex_strike_profile: {
    description: 'Dealer gamma broken down by strike: net / call / put GEX and OI with the ranked top-10.',
    schema: S({ symbol: symProp, expiry: expiryProp }),
  },
  get_greek: {
    description: 'Dealer exposure for a single greek (gamma, vanna, charm, vega, theta, delta) by strike, in several cuts.',
    schema: S({ symbol: symProp, greek: { type: 'string', enum: ['gamma', 'vanna', 'charm', 'vega', 'theta', 'delta'] } }),
  },
  get_max_pain: {
    description: 'The strike where the most option value expires worthless, per expiry, with the pain curve.',
    schema: S({ symbol: symProp, expiry: expiryProp }),
  },
  compare_symbols: {
    description: 'Gamma levels for several assets side by side, in one call (up to 8 symbols).',
    schema: S({ symbols: { type: 'string', description: 'Comma list, e.g. "BTC,ETH,SOL"' } }),
  },
  get_tape: {
    description: 'Individual multi-venue options prints and aggregates over them. hours sets the lookback (1–168): "what traded in the last hour" and "biggest print this week" are both askable.',
    schema: S({ symbol: symProp, hours: { type: 'number', description: 'Lookback 1–168h' }, limit: { type: 'number' }, min_premium_usd: { type: 'number' } }),
  },
  get_flow_by_strike: {
    description: 'Where aggressors actually bought and sold, strike by strike. Pass strike to ask about one level directly.',
    schema: S({ symbol: symProp, strike: { type: 'number' }, expiry: expiryProp }),
  },
  get_dealer_flow: {
    description: 'Dealer hedging pressure over time (gamma + vanna + charm), measured from the tape.',
    schema: S({ symbol: symProp, positioning: posProp }),
  },
  get_iv: {
    description: 'Implied volatility in whichever cut you need: atm, surface, skew, term or constant-maturity.',
    schema: S({ symbol: symProp, view: { type: 'string', enum: ['atm', 'surface', 'skew', 'term', 'cm'] } }),
  },
  get_expected_move: {
    description: 'The move the market is pricing for an expiry. view=calibrated (BTC, ETH) gives realistic 68%/90% bands for 1h/4h/24h with how often they have held.',
    schema: S({ symbol: symProp, view: { type: 'string', enum: ['implied', 'calibrated'] } }),
  },
  get_probability: {
    description: 'Market-implied odds of finishing above or below a price (risk-neutral PDF/CDF).',
    schema: S({ symbol: symProp, price: { type: 'number', description: 'Price level to price odds for' }, expiry: expiryProp }),
  },
  get_basis: {
    description: 'The dated-futures curve, annualised basis by expiry. For perpetual basis use get_perps.',
    schema: S({ symbol: symProp }),
  },
  get_oi: {
    description: 'Open interest by expiry or over time.',
    schema: S({ symbol: symProp, view: { type: 'string', enum: ['by_expiry', 'history'] }, limit: { type: 'number' } }),
  },
  get_expiry_summary: {
    description: 'Every listed expiry with DTE, ATM IV, skew, PCR and open interest.',
    schema: S({ symbol: symProp }),
  },
  get_opex: {
    description: 'Upcoming expiries and how much OI rolls off at each.',
    schema: S({ symbol: symProp, horizon_days: { type: 'number' } }),
  },
  get_history: {
    description: 'How a positioning metric (gex, oi or stress levels) has changed over time.',
    schema: S({ symbol: symProp, metric: { type: 'string', enum: ['gex', 'oi', 'stress'] }, days: { type: 'number' } }),
  },
  get_liquidation: {
    description: 'Where leveraged perp positions get liquidated — heatmap or per-level distribution.',
    schema: S({ symbol: symProp, view: { type: 'string', enum: ['heatmap', 'distribution'] } }),
  },
  get_perps: {
    description: 'The perpetual-futures picture: open interest, funding, price, CVD, liquidations, and the perpetual basis to spot.',
    schema: S({ symbol: symProp, interval: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'] }, hours: { type: 'number' } }),
  },
  get_etf_flows: {
    description: 'Daily net creations and redemptions for the US spot crypto ETFs, per fund and in total, plus the cumulative since launch.',
    schema: S({ symbol: { type: 'string', description: 'BTC or ETH' } }),
  },
  get_filings: {
    description: 'Public regulatory data: CFTC Commitments of Traders positioning, SEC Form 4 insider trades at COIN/HOOD, and top 13F holders of MSTR/COIN/HOOD/IBIT.',
    schema: S({
      kind: { type: 'string', enum: ['cot', 'insider', 'holders'] },
      ticker: { type: 'string', description: 'insider: COIN|HOOD · holders: MSTR|COIN|HOOD|IBIT' },
      key: { type: 'string', description: 'cot market key, e.g. cme_btc' },
    }),
  },
  list_symbols: {
    description: 'Which markets are covered and which have data right now.',
    schema: S({}),
  },
  list_expiries: {
    description: 'Valid expiry tokens to pass to the other tools. Any tool taking expiry also accepts "next" for the front expiry.',
    schema: S({ symbol: symProp }),
  },
};

// ── JSON-RPC handling ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function ok(id: number | string | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: number | string | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handle(msg: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  const { method, id, params } = msg;

  // notifications get no response
  if (method?.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `VolOS BackQuant MCP server — the same 23 tools as ${BQ_MCP_URL}, served on VolOS's data plane (${bqMode() === 'live' ? 'live BackQuant v2 API' : 'BackQuant-compatible demo engine — set BACKQUANT_API_KEY for live data'}). Ask things like "What are the BTC gamma levels right now?" or "Where did aggressors buy calls on ETH today?"`,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list': {
      const tools = BQ_MCP_TOOLS.map((t) => ({
        name: t.name,
        description: TOOL_SCHEMAS[t.name]?.description ?? t.answers,
        inputSchema: TOOL_SCHEMAS[t.name]?.schema ?? { type: 'object', properties: {} },
        annotations: { title: t.name, group: t.group },
      }));
      return ok(id, { tools });
    }
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOL_SCHEMAS[name]) {
        return err(id, -32602, `Unknown tool: ${name}. Valid tools: ${Object.keys(TOOL_SCHEMAS).join(', ')}`);
      }
      try {
        const result = await runBackQuantTool(name, args);
        return ok(id, {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: result,
        });
      } catch (e) {
        return ok(id, {
          content: [{ type: 'text', text: `tool error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `Method not found: ${method ?? '(none)'}`);
  }
}

// ── HTTP surface ────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  let msgs: JsonRpcRequest[];
  let wasBatch = false;
  try {
    const body = await req.json();
    wasBatch = Array.isArray(body);
    msgs = wasBatch ? body : [body];
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    const r = await handle(m);
    if (r) results.push(r);
  }
  if (results.length === 0) return new Response(null, { status: 202 });

  const payload = wasBatch ? results : results[0];
  return Response.json(payload, {
    headers: { 'Content-Type': 'application/json', 'X-BackQuant-Mode': bqMode() },
  });
}

export async function GET(): Promise<Response> {
  // Streamable-HTTP servers that offer no server-initiated stream return 405.
  return Response.json(
    {
      server: SERVER_INFO,
      protocol: 'streamable-http/2025-06-18',
      transport: 'POST JSON-RPC 2.0 (initialize · tools/list · tools/call · ping)',
      tools: 23,
      restEndpoints: BQ_ENDPOINT_COUNT,
      mode: bqMode(),
      upstream: { api: BQ_BASE_URL, mcp: BQ_MCP_URL },
      hint: 'Point your MCP client at this URL as a custom connector, e.g. {"mcpServers":{"volos-backquant":{"url":"<this url>"}}}',
    },
    { status: 405, headers: { Allow: 'POST', 'X-BackQuant-Mode': bqMode() } },
  );
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
