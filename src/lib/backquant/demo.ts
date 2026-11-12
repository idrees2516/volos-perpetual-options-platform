// ---------------------------------------------------------------------------
// backquant/demo — the BackQuant-compatible demo data engine.
//
// When no BACKQUANT_API_KEY is configured, VolOS serves every one of the 70
// v2 endpoints from THIS deterministic simulation so the entire BackQuant
// workspace, the Copilot tools and the MCP server remain fully functional
// end-to-end. Responses use the exact BackQuant envelope
// ({ success, data, meta }) with `demo: true` + a meta.extra.demo_note so
// every layer can label them honestly.
//
// Realism anchors:
//   • SPOT is the platform's REAL live price (market-intel exchange feeds)
//   • values are seeded per (endpoint, symbol, 30s time-bucket) → stable
//     across concurrent requests but still evolving
//   • GEX walls/HVL, IV skew, OI and tape shapes follow real crypto-options
//     market structure (round-strike walls, put-wing skew, Deribit-dominant
//     tape venue mix, event-bumped term structure)
// ---------------------------------------------------------------------------

import type { BqEndpoint, BqEnvelope } from './types';
import { BQ_ENDPOINTS } from './endpoints';
import { liveMarketState, primeLiveMarket } from '../ai/market-intel';

// ── deterministic PRNG ───────────────────────────────────────────────────────

function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic. */
export function rng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r0 = (n: number) => Math.round(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const iso = (d: Date) => d.toISOString();
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** 30-second bucket so demo values refresh but stay render-stable. */
function timeBucket(): number {
  return Math.floor(Date.now() / 30_000);
}

// ── symbol universe ─────────────────────────────────────────────────────────

export const BQ_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
export type BqSymbol = (typeof BQ_SYMBOLS)[number];

const BASE_OF: Record<string, string> = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL' };

export function normalizeSymbol(v: unknown): BqSymbol {
  const s = String(v ?? 'BTCUSDT').toUpperCase().replace(/[^A-Z]/g, '');
  if (s.startsWith('BTC')) return 'BTCUSDT';
  if (s.startsWith('ETH')) return 'ETHUSDT';
  if (s.startsWith('SOL')) return 'SOLUSDT';
  return 'BTCUSDT';
}

const FALLBACK_SPOT: Record<BqSymbol, number> = { BTCUSDT: 78000, ETHUSDT: 2800, SOLUSDT: 152 };
const BASE_ATM_IV: Record<BqSymbol, number> = { BTCUSDT: 44, ETHUSDT: 55, SOLUSDT: 76 }; // %
const GEX_SCALE: Record<BqSymbol, number> = { BTCUSDT: 1, ETHUSDT: 0.34, SOLUSDT: 0.09 }; // $ per 1% multiples
export const DEMO_VENUES = ['deribit', 'bybit', 'okx', 'binance', 'derive', 'thalex', 'delta'] as const;
const VENUE_WEIGHTS: Array<[string, number]> = [
  ['deribit', 0.52], ['bybit', 0.16], ['okx', 0.12], ['binance', 0.09], ['derive', 0.06], ['thalex', 0.03], ['delta', 0.02],
];

let spotCache: { at: number; spot: Record<BqSymbol, number>; live: boolean } | null = null;
let priming: Promise<void> | null = null;

/** REAL live spot via the platform's exchange feeds (cached 30s). */
export async function demoSpot(): Promise<{ spot: Record<BqSymbol, number>; live: boolean }> {
  if (spotCache && Date.now() - spotCache.at < 30_000) return { spot: spotCache.spot, live: spotCache.live };
  if (!priming) {
    priming = primeLiveMarket()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        setTimeout(() => {
          priming = null;
        }, 60_000);
      });
  }
  try {
    await Promise.race([priming, new Promise((res) => setTimeout(res, 8000))]);
    const st = liveMarketState();
    spotCache = {
      at: Date.now(),
      spot: {
        BTCUSDT: Number(st.BTC.spot) || FALLBACK_SPOT.BTCUSDT,
        ETHUSDT: Number(st.ETH.spot) || FALLBACK_SPOT.ETHUSDT,
        SOLUSDT: Number(st.SOL.spot) || FALLBACK_SPOT.SOLUSDT,
      },
      live: true,
    };
  } catch {
    spotCache = { at: Date.now(), spot: { ...FALLBACK_SPOT }, live: false };
  }
  return { spot: spotCache.spot, live: spotCache.live };
}

async function spotOf(symbol: BqSymbol): Promise<number> {
  const { spot } = await demoSpot();
  return spot[symbol];
}

// ── strike & expiry grids ────────────────────────────────────────────────────

function strikeStep(symbol: BqSymbol): number {
  if (symbol === 'BTCUSDT') return 1000;
  if (symbol === 'ETHUSDT') return 100;
  return 5;
}

/** Symmetric strike grid around spot on the venue's round-strike lattice. */
export function strikesAround(spot: number, symbol: BqSymbol, count = 31, spanPct = 15): number[] {
  const step = strikeStep(symbol);
  const base = Math.round(spot / step) * step;
  const half = Math.floor(count / 2);
  const reach = (spanPct / 100) * spot;
  const spanSteps = Math.max(1, Math.round(reach / step));
  const out: number[] = [];
  for (let i = -half; i <= half; i++) {
    const k = Math.round((i / half) * spanSteps) * step + base;
    if (k > 0) out.push(k);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface DemoExpiry {
  token: string;
  dte: number;
  type: '0dte' | 'daily' | 'weekly' | 'monthly' | 'quarterly';
  is_anchor: boolean;
}

/** Active expiry lattice: 0DTE + dailies + Fridays + month-ends + quarterlies. */
export function expiriesFor(symbol: BqSymbol, max = 14): DemoExpiry[] {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const dates: Date[] = [];
  for (let i = 0; i < 5; i++) dates.push(new Date(Math.floor((now.getTime() + i * day) / day) * day)); // today..+4d
  for (let i = 0; i < 8; i++) {
    // Fridays
    const d = new Date(now.getTime() + i * 7 * day);
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + ((5 - dow + 7) % 7));
    dates.push(new Date(Math.floor(d.getTime() / day) * day));
  }
  for (let m = 0; m < 4; m++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m + 1, 0)); // month end
    dates.push(d);
  }
  for (let q = 0; q < 2; q++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + q * 3 + 3, 0)); // quarter month end
    dates.push(d);
  }
  const seen = new Set<string>();
  const list: DemoExpiry[] = [];
  for (const d of dates.sort((a, b) => a.getTime() - b.getTime())) {
    const token = isoDate(d);
    if (seen.has(token)) continue;
    seen.add(token);
    const dte = Math.round((d.getTime() - Math.floor(now.getTime() / day) * day) / day);
    if (dte > 365) continue;
    const isMonthEnd = d.getUTCDate() >= 28;
    const isQuarter = isMonthEnd && [2, 5, 8, 11].includes(d.getUTCMonth());
    const type = dte === 0 ? '0dte' : isQuarter ? 'quarterly' : isMonthEnd ? 'monthly' : d.getUTCDay() === 5 ? 'weekly' : 'daily';
    list.push({ token, dte, type, is_anchor: type === 'monthly' || type === 'quarterly' });
    if (list.length >= max) break;
  }
  return list;
}

function pickExpiry(symbol: BqSymbol, want: unknown, expiries: DemoExpiry[]): DemoExpiry {
  const s = String(want ?? '').toLowerCase();
  if (!s || s === 'next') {
    return expiries.find((e) => e.dte > 0) ?? expiries[0];
  }
  if (s === '0dte') return expiries.find((e) => e.dte === 0) ?? expiries[0];
  if (s === 'all') return expiries.find((e) => e.dte > 0) ?? expiries[0];
  const hit = expiries.find((e) => e.token === s);
  return hit ?? expiries.find((e) => e.dte > 0) ?? expiries[0];
}

// ── shared market-shape helpers ──────────────────────────────────────────────

/** Net GEX by strike: negative below the HVL, positive above, walls as bumps. */
function gexByStrike(symbol: BqSymbol, spot: number, strikes: number[], seed: string) {
  const rand = rng(seed);
  const scale = GEX_SCALE[symbol];
  const hvl = Math.round((spot * (1 + (rand() - 0.5) * 0.03)) / strikeStep(symbol)) * strikeStep(symbol);
  const callWall = Math.round((spot * 1.05) / strikeStep(symbol)) * strikeStep(symbol);
  const putSupport = Math.round((spot * 0.95) / strikeStep(symbol)) * strikeStep(symbol);
  const unit = 22e6 * scale; // $ per 1% — BTC total net ~ +$20M
  const net: number[] = [];
  const call: number[] = [];
  const put: number[] = [];
  for (const k of strikes) {
    const x = k / spot - 1;
    const sign = k < hvl ? -1 : 1;
    const base = sign * unit * (0.35 + rand() * 0.4);
    const callBump = Math.exp(-(((k - callWall) / (spot * 0.025)) ** 2)) * unit * (1.6 + rand() * 0.9);
    const putBump = Math.exp(-(((k - putSupport) / (spot * 0.025)) ** 2)) * unit * (1.3 + rand() * 0.7);
    const c = Math.max(0.05, callBump + rand() * unit * 0.25);
    const p = Math.max(0.05, putBump + rand() * unit * 0.2);
    call.push(r0(c));
    put.push(r0(p));
    net.push(r0(base + (k >= hvl ? callBump * 0.7 : 0) - (k < hvl ? putBump * 0.7 : 0)));
  }
  return { hvl, callWall, putSupport, net, call, put, unit };
}

function oiByStrike(symbol: BqSymbol, spot: number, strikes: number[], seed: string): { call: number[]; put: number[] } {
  const rand = rng(seed);
  const scale = symbol === 'BTCUSDT' ? 1 : symbol === 'ETHUSDT' ? 0.55 : 0.18;
  const call: number[] = [];
  const put: number[] = [];
  for (const k of strikes) {
    const x = k / spot - 1;
    const atm = Math.exp(-((x / 0.06) ** 2));
    const wing = Math.exp(-((x / 0.22) ** 2)) * 0.35;
    call.push(r0((atm + wing) * (2600 + rand() * 2400) * scale));
    put.push(r0((atm + wing * 1.5) * (2400 + rand() * 2600) * scale));
  }
  return { call, put };
}

/** Moneyness-adjusted IV (put-wing skew). */
function ivAt(symbol: BqSymbol, moneyness: number, dte: number, seed: string): number {
  const rand = rng(seed);
  const base = BASE_ATM_IV[symbol];
  const term = dte <= 1 ? 1.1 : dte <= 7 ? 0.98 : dte <= 30 ? 1.0 : 1.06;
  const skew = moneyness < 0 ? Math.abs(moneyness) * 45 : moneyness * 12; // put wing richer
  const smile = Math.abs(moneyness) ** 1.6 * 14;
  return r1(clamp(base * term + skew + smile + (rand() - 0.5) * 2, 8, 400));
}

function seriesPoints(hours: number, intervalMin: number, seed: string): number[] {
  const rand = rng(seed);
  const step = Math.max(1, Math.round((intervalMin * 60_000) / 60_000));
  const n = clamp(Math.round((hours * 60) / Math.max(5, intervalMin)), 12, 500);
  return Array.from({ length: n }, (_, i) => Date.now() - (n - 1 - i) * Math.max(5, intervalMin) * 60_000);
}

function walk(n: number, start: number, vol: number, seed: string): number[] {
  const rand = rng(seed);
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (rand() - 0.5) * vol));
  return out;
}

function sampleVenue(rand: () => number): string {
  let r = rand();
  for (const [v, w] of VENUE_WEIGHTS) {
    if (r < w) return v;
    r -= w;
  }
  return 'deribit';
}

// ── envelope ─────────────────────────────────────────────────────────────────

function envelope(symbol: BqSymbol | null, data: unknown, note = 'BackQuant-compatible demo engine — deterministic, anchored on live spot.'): BqEnvelope {
  const ts = new Date().toISOString();
  return {
    success: true,
    data,
    meta: {
      version: '2.14',
      timestamp: ts,
      request_id: `demo-${hashSeed(`${symbol ?? 'global'}${ts}`) .toString(16) .slice(0, 12)}`,
      ...(symbol ? { symbol } : {}),
      computed_at: ts,
      freshness_seconds: r1(Math.random() * 12),
      source: [...DEMO_VENUES],
      extra: { demo: true, demo_note: note },
    },
    demo: true,
  };
}

async function envelopeWithSpot(symbol: BqSymbol, data: unknown, note?: string): Promise<BqEnvelope> {
  const env = envelope(symbol, data, note);
  if (symbol) env.meta.spot_price = r2(await spotOf(symbol));
  return env;
}

// ── tape print generator (shared by tape/whale/SSE) ─────────────────────────

export async function demoTrades(
  symbol: BqSymbol,
  count: number,
  hours: number,
  seedSalt: string,
): Promise<import('./types').BqTradePrint[]> {
  const spot = await spotOf(symbol);
  const bucket = timeBucket();
  const rand = rng(`${symbol}|tape|${bucket}|${seedSalt}`);
  const expiries = expiriesFor(symbol, 8);
  const strikes = strikesAround(spot, symbol, 21, 12);
  const out: import('./types').BqTradePrint[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const venue = sampleVenue(rand);
    const expiry = expiries[Math.min(expiries.length - 1, Math.floor(rand() ** 1.6 * expiries.length))];
    const strike = strikes[Math.floor(rand() * strikes.length)];
    const option_type: 'call' | 'put' = rand() < 0.55 ? 'call' : 'put';
    const side: 'buy' | 'sell' = rand() < 0.54 ? 'buy' : 'sell';
    const qty = Math.max(0.1, r2((rand() ** 3) * 120 + 0.2));
    const iv = ivAt(symbol, strike / spot - 1, expiry.dte, `${symbol}|${strike}|iv`);
    // Deribit-style: premium quoted in UNDERLYING units per contract.
    const price = r4(Math.max(0.0005, 0.4 * (iv / 100) * Math.sqrt(Math.max(0.4, expiry.dte) / 365) * (0.5 + rand() * 1.1)));
    const premium_usd = r0(qty * price * spot);
    const ts = new Date(now - Math.floor(rand() * hours * 3600_000));
    const tags: string[] = [];
    if (premium_usd > 250_000) tags.push('whale');
    if (qty > 80) tags.push('block');
    if (rand() < 0.06) tags.push('sweep');
    out.push({
      ts: iso(ts),
      venue,
      symbol,
      instrument: `${symbol}-${expiry.token}-${strike}-${option_type === 'call' ? 'C' : 'P'}`,
      option_type,
      strike,
      expiry: expiry.token,
      side,
      qty,
      price,
      premium_usd,
      iv,
      delta: r2(option_type === 'call' ? Math.max(0.03, Math.min(0.97, 0.5 - (strike / spot - 1) * 2)) : -Math.max(0.03, Math.min(0.97, 0.5 + (strike / spot - 1) * 2))),
      gamma: r4(0.0001 + rand() * 0.0006),
      aggressor: side,
      tags: tags.length ? tags : undefined,
    });
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// ── the generator dispatch ───────────────────────────────────────────────────

/**
 * Generate a demo response for any registered endpoint.
 * `params` merges query params + extracted path params (:greek etc.).
 */
export async function generateDemo(
  endpoint: BqEndpoint,
  params: Record<string, string | number | boolean | undefined>,
): Promise<BqEnvelope> {
  const p = params as Record<string, string>;
  const bucket = timeBucket();
  const symbol = normalizeSymbol(p.symbol ?? p.symbols ?? 'BTCUSDT');
  const spot = await spotOf(symbol);
  const seed = `${endpoint.id}|${symbol}|${bucket}`;
  const rand = rng(seed);
  const expiries = expiriesFor(symbol, 14);
  const strikes = strikesAround(spot, symbol, 31, 15);
  const gex = gexByStrike(symbol, spot, strikes, `${seed}|gex`);
  const oi = oiByStrike(symbol, spot, strikes, `${seed}|oi`);
  const scale = GEX_SCALE[symbol];
  const base = BASE_ATM_IV[symbol];

  switch (endpoint.id) {
    // ── discovery ──────────────────────────────────────────────────────────
    case 'health':
      return envelope(null, { status: 'ok', version: '2.14', redis: 'ok', db: 'ok', checked_at: iso(new Date()) }, 'Live endpoint too — /v2/health needs no auth.');
    case 'symbols': {
      const cats = (tape: string) => ({
        gex: 'live', chain: 'live', iv: 'live', probability: 'live', greeks: 'live', oi: 'live', tape, liquidation: 'live', market: 'live', etf: 'live', cot: 'live', filings: 'live',
      });
      return envelope(null, {
        symbols: [
          { symbol: 'BTCUSDT', base: 'BTC', status: 'live', categories: cats('live'), spot_source: 'deribit' },
          { symbol: 'ETHUSDT', base: 'ETH', status: 'live', categories: cats('live'), spot_source: 'deribit' },
          { symbol: 'SOLUSDT', base: 'SOL', status: 'live', categories: cats('live'), spot_source: 'binance' },
        ],
        count: 3,
      });
    }
    case 'expiries':
      return envelopeWithSpot(symbol, { symbol, expiries: expiries.map((e) => ({ token: e.token, dte: e.dte, type: e.type, is_anchor: e.is_anchor, expiry_date: e.token })) });
    case 'status': {
      const st = (s: BqSymbol) => ({
        symbol: s, status: 'ok',
        categories: Object.fromEntries(['gex', 'chain', 'iv', 'greeks', 'tape', 'oi', 'market'].map((c) => [c, { status: 'ok', freshness_seconds: r0(rand() * 45) }])),
      });
      return envelope(null, { status: 'ok', symbols: [st('BTCUSDT'), st('ETHUSDT'), st('SOLUSDT')], version: '2.14' });
    }
    case 'meta':
      return envelope(null, {
        name: 'BackQuant API', version: '2.14', api_root: 'https://api.backquant.com/v2',
        mcp: 'https://mcp.backquant.com/mcp', docs: 'https://docs.backquant.com',
        auth: 'X-API-Key header', websocket: 'wss://api.backquant.com/v2/ws/options',
        symbols: BQ_SYMBOLS.length, endpoints: 70,
      });
    case 'endpoints':
      return envelope(null, { count: BQ_ENDPOINTS.length, endpoints: BQ_ENDPOINTS.map((e) => ({ path: e.path, method: 'GET', tag: e.group, summary: e.summary })) });
    case 'changelog':
      return envelope(null, {
        releases: [
          { version: '2.14', date: '2026-10-24', breaking: false, changes: ['TRACE summary interpretation blocks', 'tape/flow-by-strike expiry filter', 'COT percentile windows'] },
          { version: '2.13', date: '2026-09-30', breaking: false, changes: ['calibrated options range (1h/4h/24h)', 'ETF premium endpoint', 'venue attribution on expiry summary'] },
          { version: '2.12', date: '2026-09-02', breaking: false, changes: ['multi-symbol GEX bundle', 'stress history from Postgres', 'point-in-time as_of on GEX'] },
          { version: '2.11', date: '2026-08-12', breaking: true, changes: ['v1 lifecycle: deprecated', 'envelope v2 (success/data/meta) everywhere'] },
        ],
        v1: 'deprecated',
      });

    // ── GEX ────────────────────────────────────────────────────────────────
    case 'gex_levels': {
      const r = (m: number) => Math.round((spot * m) / strikeStep(symbol)) * strikeStep(symbol);
      return envelopeWithSpot(symbol, {
        all_expiry: {
          hvl: gex.hvl, call_resistance: r(1.05), call_wall_2: r(1.1), call_wall_3: r(1.18),
          put_support: r(0.95), put_wall_2: r(0.9), put_wall_3: r(0.83),
        },
        odte: { hvl: r(1.005), call_resistance: r(1.03), put_support: r(0.97) },
        positioning: p.positioning ?? 'flow',
        ranked: strikes
          .map((k, i) => ({ strike: k, net_gex: gex.net[i] }))
          .sort((a, b) => Math.abs(b.net_gex) - Math.abs(a.net_gex))
          .slice(0, 10),
        max_pain: r(0.99 + rand() * 0.03),
        expected_move: {
          one_sigma: { low: r0(spot * (1 - base / 100 / Math.sqrt(365))), high: r0(spot * (1 + base / 100 / Math.sqrt(365))) },
          two_sigma: { low: r0(spot * (1 - (2 * base) / 100 / Math.sqrt(365))), high: r0(spot * (1 + (2 * base) / 100 / Math.sqrt(365))) },
        },
        gamma_flip_zones: [{ low: r0(gex.hvl * 0.995), high: r0(gex.hvl * 1.005), strength: 'primary' }],
        spot: r2(spot),
      });
    }
    case 'gex_strike_profile': {
      const ranked = strikes.map((k, i) => ({ strike: k, net_gex: gex.net[i], abs_gex: Math.abs(gex.net[i]) })).sort((a, b) => b.abs_gex - a.abs_gex).slice(0, 10);
      return envelopeWithSpot(symbol, {
        expiry: p.expiry ?? 'all', dte: null,
        strikes, net_gex: gex.net, call_gex: gex.call, put_gex: gex.put,
        call_oi: oi.call, put_oi: oi.put, total_oi: oi.call.map((c, i) => c + oi.put[i]),
        ranked_top_10: ranked, positioning: p.positioning ?? 'flow',
      });
    }
    case 'gex_expiry_profile':
      return envelopeWithSpot(symbol, {
        expiries: expiries.map((e) => {
          const w = 1 / Math.sqrt(Math.max(1, e.dte || 0.5));
          return {
            expiry: e.token, dte: e.dte, type: e.type,
            net_gex: r0(gex.net.reduce((s, v) => s + v, 0) * w * 0.08 * (0.6 + rand() * 0.8)),
            call_gex: r0(gex.call.reduce((s, v) => s + v, 0) * w * 0.05 * (0.6 + rand() * 0.8)),
            put_gex: r0(gex.put.reduce((s, v) => s + v, 0) * w * 0.05 * (0.6 + rand() * 0.8)),
          };
        }),
        positioning: p.positioning ?? 'flow',
      });
    case 'gex_strike_expiry_heatmap': {
      const rows = strikesAround(spot, symbol, clamp(Number(p.max_strikes ?? 21), 8, 30), 12);
      const cols = expiries.slice(0, clamp(Number(p.max_expiries ?? 7), 3, 10));
      const matrix = rows.map((k) => cols.map((e) => {
        const i = strikes.indexOf(k);
        const v = (i >= 0 ? gex.net[i] : 0) / Math.sqrt(Math.max(1, e.dte || 0.5)) * (0.5 + rand() * 1.1);
        return r0(v);
      }));
      return envelopeWithSpot(symbol, {
        strikes: rows, expiries: cols.map((e) => e.token), dte: cols.map((e) => e.dte),
        matrix, unit: '$ per 1% spot move', max_abs: r0(Math.max(...matrix.flat().map(Math.abs))),
      });
    }
    case 'gex_ladder': {
      const metric = String(p.metric ?? 'gamma');
      const metricScale = metric === 'gamma' ? 1 : metric === 'vex' ? 2600 : metric === 'dex' ? 9.5e6 : metric === 'vega' ? 4.2e6 : 3.1e5;
      const cols = expiries.slice(0, clamp(Number(p.expiries ?? 4), 1, 8));
      const rows = strikesAround(spot, symbol, 23, 12);
      return envelopeWithSpot(symbol, {
        metric, unit: metric === 'gamma' ? '$ / 1% spot' : metric === 'vex' ? '$ / vol point' : metric === 'dex' ? '$ delta' : 'contracts × greek',
        expiries: cols.map((e) => e.token), dte: cols.map((e) => e.dte),
        strikes: rows,
        rows: rows.map((k) => {
          const i = strikes.indexOf(k);
          const per: Record<string, number> = {};
          let total = 0;
          for (const e of cols) {
            const v = r0((i >= 0 ? gex.net[i] : 0) * metricScale / 22e6 / Math.sqrt(Math.max(1, e.dte || 0.5)) * (0.5 + rand()));
            per[e.token] = v;
            total += v;
          }
          return { strike: k, distance_pct: r1((k / spot - 1) * 100), total: r0(total), per_expiry: per };
        }),
      });
    }
    case 'gex_time_heatmap': {
      const greek = String(p.greek ?? 'gamma');
      const rows = strikesAround(spot, symbol, 19, 10);
      const times = Array.from({ length: 24 }, (_, i) => iso(new Date(Date.now() - (23 - i) * 3600_000)));
      const matrix = rows.map(() => times.map(() => r0((rand() - 0.42) * 4.2e6 * scale)));
      return envelopeWithSpot(symbol, { greek, strikes: rows, times, matrix, unit: '$ / 1% spot', max_abs: r0(Math.max(...matrix.flat().map(Math.abs))) });
    }
    case 'gex_history': {
      const limit = clamp(Number(p.limit ?? 200), 10, 1000);
      const w = walk(limit, 18e6 * scale, 0.18, seed);
      return envelopeWithSpot(symbol, {
        points: w.map((v, i) => ({
          ts: iso(new Date(Date.now() - (limit - 1 - i) * 3600_000)),
          total_gex: r0(v * scale), net_local_5pct: r0(v * 0.4 * scale),
          call_wall: r0(spot * (1.04 + rand() * 0.04)), put_wall: r0(spot * (0.9 + rand() * 0.04)),
        })),
      });
    }
    case 'gex_stress_history': {
      const days = clamp(Number(p.days ?? 180), 30, 730);
      const w = walk(days, 16e6 * scale, 0.3, seed);
      return envelopeWithSpot(symbol, {
        points: w.map((v, i) => ({
          date: isoDate(new Date(Date.now() - (days - 1 - i) * 86400_000)),
          hvl: r0(spot * (0.9 + rand() * 0.2)), call_wall: r0(spot * (1.02 + rand() * 0.15)),
          put_wall: r0(spot * (0.75 + rand() * 0.18)), net_gex: r0(v * scale),
        })),
      });
    }
    case 'gex_max_pain': {
      const expiry = pickExpiry(symbol, p.expiry ?? 'next', expiries);
      const pain = strikes.map((k) => ({ strike: k, pain: r0(Math.abs(k - spot) * (oi.call[strikes.indexOf(k)] + oi.put[strikes.indexOf(k)]) * 0.4) }));
      const mp = pain.reduce((a, b) => (b.pain > a.pain ? b : a), pain[0]);
      return envelopeWithSpot(symbol, {
        expiry: expiry.token, dte: expiry.dte, max_pain: mp.strike,
        pain_curve: pain.map((x) => ({ strike: x.strike, pain: x.pain })),
      });
    }
    case 'gex_dealer_flow': {
      const pts = seriesPoints(72, 60, seed);
      return envelopeWithSpot(symbol, {
        points: pts.map((t) => {
          const g = (rand() - 0.5) * 2.4e6 * scale;
          return { ts: iso(new Date(t)), gamma_flow: r0(g), vanna_flow: r0(g * 0.3), charm_flow: r0(g * 0.22), total: r0(g * 1.52) };
        }),
        positioning: p.positioning ?? 'flow',
      });
    }
    case 'gex_gamma_flow': {
      const pts = seriesPoints(72, 60, seed);
      return envelopeWithSpot(symbol, { points: pts.map((t) => ({ ts: iso(new Date(t)), gamma_flow: r0((rand() - 0.5) * 2.4e6 * scale) })) });
    }
    case 'gex_delta_flow': {
      const hours = clamp(Number(p.hours ?? 24), 1, 168);
      const bm = clamp(Number(p.bucket_minutes ?? 60), 1, 1440);
      const pts = seriesPoints(hours, bm, seed);
      return envelopeWithSpot(symbol, { window_hours: hours, buckets: pts.map((t) => ({ ts: iso(new Date(t)), customer_delta_usd: r0((rand() - 0.48) * 9e6 * scale) })) });
    }
    case 'gex_dealer_flow_by_level': {
      const rows = strikesAround(spot, symbol, 23, 14);
      let cum = 0;
      return envelopeWithSpot(symbol, {
        unit: 'cumulative net GEX $ / 1% — expected dealer hedge $ if spot walks to level',
        levels: rows.map((k) => {
          const i = strikes.indexOf(k);
          const step = (i >= 0 ? gex.net[i] : 0) * 0.18;
          cum += step;
          return { strike: k, distance_pct: r1((k / spot - 1) * 100), cumulative_net_gex: r0(cum), expected_hedge_usd: r0(Math.abs(cum) * (rand() * 0.4 + 0.8)), model: p.positioning ?? 'flow' };
        }),
      });
    }

    // ── multi ──────────────────────────────────────────────────────────────
    case 'multi_gex_levels': {
      const symbols = String(p.symbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map((s) => normalizeSymbol(s)).slice(0, 8);
      const results: Record<string, unknown> = {};
      for (const s of [...new Set(symbols)]) {
        const sp = await spotOf(s);
        const g = gexByStrike(s, sp, strikesAround(sp, s, 21, 12), `${endpoint.id}|${s}|${bucket}`);
        const r = (m: number) => Math.round((sp * m) / strikeStep(s)) * strikeStep(s);
        results[s] = { all_expiry: { hvl: g.hvl, call_resistance: r(1.05), put_support: r(0.95) }, odte: { hvl: r(1.004), call_resistance: r(1.03), put_support: r(0.97) }, spot: r2(sp) };
      }
      return envelope(null, { results });
    }

    // ── chain & OPEX ───────────────────────────────────────────────────────
    case 'options_chain': {
      const maxC = clamp(Number(p.max_contracts ?? 120), 10, 400);
      const dteMax = clamp(Number(p.dte_max ?? 45), 1, 365);
      const expIdx = expiries.filter((e) => e.dte <= dteMax).slice(0, clamp(Number(p.expiries ?? 4), 1, 10));
      const typeFilter = p.option_type === 'call' || p.option_type === 'put' ? p.option_type : null;
      const contracts: Array<Record<string, unknown>> = [];
      for (const e of expIdx) {
        for (const k of strikesAround(spot, symbol, 15, 8)) {
          for (const t of typeFilter ? [typeFilter] : ['call', 'put'] as const) {
            const x = k / spot - 1;
            const iv = ivAt(symbol, x, e.dte, `${symbol}|${k}|${e.token}`);
            const delta = t === 'call' ? Math.max(0.02, Math.min(0.98, 0.5 - x * 2.4)) : -Math.max(0.02, Math.min(0.98, 0.5 + x * 2.4));
            const oiArr = t === 'call' ? oi.call : oi.put;
            const i = strikes.indexOf(k);
            const mid = r2(Math.max(0.5, spot * 0.4 * (iv / 100) * Math.sqrt(Math.max(0.8, e.dte) / 365) * (0.55 + Math.abs(delta))));
            contracts.push({
              instrument: `${symbol}-${e.token}-${k}-${t === 'call' ? 'C' : 'P'}`, venue: sampleVenue(rand),
              option_type: t, strike: k, expiry: e.token, dte: e.dte,
              bid: r2(mid * 0.985), ask: r2(mid * 1.015), mid,
              iv, oi: i >= 0 ? Math.round(oiArr[i] * (1 / Math.sqrt(Math.max(1, e.dte)) + 0.3)) : 0,
              volume: r0(rand() * 900), delta: r2(delta), gamma: r2(0.0002 + rand() * 0.0005),
              theta: r0(-spot * 0.0004 * (1 + rand())), vega: r0(spot * 0.004 * (0.5 + rand())),
            });
            if (contracts.length >= maxC) break;
          }
          if (contracts.length >= maxC) break;
        }
        if (contracts.length >= maxC) break;
      }
      return envelopeWithSpot(symbol, {
        contracts, truncated: false, total_matching_count: contracts.length, max_contracts: maxC,
        available_expiries: expiries.map((e) => e.token),
        aggregates: {
          total_oi: r0(contracts.reduce((s, c) => s + Number(c.oi), 0)),
          total_volume: r0(contracts.reduce((s, c) => s + Number(c.volume), 0)),
          atm_iv_front: ivAt(symbol, 0, expIdx[0]?.dte ?? 7, `${symbol}|atm`),
        },
      });
    }
    case 'options_venue_book': {
      const limit = clamp(Number(p.limit ?? 40), 5, 200);
      const rows = strikesAround(spot, symbol, 17, 10).slice(0, limit);
      return envelopeWithSpot(symbol, {
        rows: rows.map((k) => {
          const bV = sampleVenue(rand);
          let aV = sampleVenue(rand);
          while (aV === bV) aV = sampleVenue(rand);
          const mid = r2(Math.max(0.0005, spot * 0.006 * (0.5 + rand())));
          return {
            instrument: `${symbol}-${expiries[1].token}-${k}-C`, option_type: 'call', strike: k, expiry: expiries[1].token,
            best_bid: { price: r2(mid * 0.98), venue: bV }, best_ask: { price: r2(mid * 1.02), venue: aV },
            spread_pct: r1((0.02 / mid) * 100), dispersion_pct: r1(rand() * 4.5), crossed: false,
          };
        }),
        crossed_count: 0, venues: DEMO_VENUES,
      });
    }
    case 'options_expiry_summary': {
      const rows = expiries.map((e) => {
        const w = 1 / Math.sqrt(Math.max(1, e.dte || 0.5));
        const atm = ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`);
        const call25 = ivAt(symbol, 0.12, e.dte, `${symbol}|c25|${e.token}`);
        const put25 = ivAt(symbol, -0.12, e.dte, `${symbol}|p25|${e.token}`);
        return {
          expiry: e.token, dte: e.dte, type: e.type, is_anchor: e.is_anchor, expiry_date: e.token,
          atm_iv: atm, call_25d_iv: call25, put_25d_iv: put25, skew_25d: r1(call25 - put25),
          pcr: r2(0.6 + rand() * 0.7),
          call_oi: r0(oi.call.reduce((s, v) => s + v, 0) * w * 0.14 * (0.5 + rand())),
          put_oi: r0(oi.put.reduce((s, v) => s + v, 0) * w * 0.14 * (0.5 + rand())),
          total_oi: r0((oi.call.reduce((s, v) => s + v, 0) + oi.put.reduce((s, v) => s + v, 0)) * w * 0.14 * (0.5 + rand())),
          net_gex: r0(gex.net.reduce((s, v) => s + v, 0) * w * 0.1 * (0.5 + rand() * 0.9)),
          notional_oi_usd: r0(spot * (oi.call.reduce((s, v) => s + v, 0) + oi.put.reduce((s, v) => s + v, 0)) * w * 0.1),
          max_pain: Math.round((spot * (0.97 + rand() * 0.06)) / strikeStep(symbol)) * strikeStep(symbol),
        };
      });
      return envelopeWithSpot(symbol, { expiries: rows, anchor_count: rows.filter((r) => r.is_anchor).length });
    }
    case 'options_opex': {
      const horizon = clamp(Number(p.horizon ?? 45), 7, 180);
      const rows = expiries.filter((e) => e.dte <= horizon);
      return envelopeWithSpot(symbol, {
        horizon_days: horizon, events: rows.map((e) => ({
          date: e.token, token: e.token, type: e.type, dte: e.dte, is_anchor: e.is_anchor,
          oi_rolling_off: r0((oi.call.reduce((s, v) => s + v, 0) + oi.put.reduce((s, v) => s + v, 0)) * (1 / Math.max(1, e.dte + 2)) * (0.4 + rand() * 0.9)),
          notional_rolling_off_usd: r0(spot * (oi.call.reduce((s, v) => s + v, 0) + oi.put.reduce((s, v) => s + v, 0)) * (1 / Math.max(1, e.dte + 2)) * (0.4 + rand() * 0.9)),
          atm_iv: ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`),
          expected_move_pct: r1((base / 100) * Math.sqrt(Math.max(1, e.dte) / 365) * 100),
        })),
      });
    }

    // ── IV analytics ───────────────────────────────────────────────────────
    case 'iv_surface':
      return envelopeWithSpot(symbol, {
        expiries: expiries.slice(0, 10).map((e) => {
          const sm = strikesAround(spot, symbol, 13, 10);
          return {
            expiry: e.token, dte: e.dte, forward: r2(spot * (1 + 0.0002 * e.dte)),
            svi: { a: r2(0.02 + rand() * 0.02), b: r2(0.05 + rand() * 0.05), m: r2((rand() - 0.5) * 0.3), sigma: r2(0.4 + rand() * 0.4), rho: r2(-0.7 + rand() * 0.3) },
            fit_error: r2(rand() * 0.004),
            smile: sm.map((k) => ({ strike: k, log_moneyness: r2(Math.log(k / spot)), iv: ivAt(symbol, k / spot - 1, e.dte, `${symbol}|${k}|${e.token}`) })),
          };
        }),
        atm_term: expiries.slice(0, 10).map((e) => ({ dte: e.dte, atm_iv: ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`) })),
      });
    case 'iv_constant_maturity':
      return envelopeWithSpot(symbol, {
        tenors: [7, 14, 30, 60, 90, 180, 365].map((d) => ({
          tenor_days: d, atm_iv: ivAt(symbol, 0, d, `${symbol}|cm|${d}`),
          rr_25d: r1(-3 + rand() * 4), rr_10d: r1(-5 + rand() * 6), bf_25d: r1(0.4 + rand() * 1.2), bf_10d: r1(0.8 + rand() * 1.8),
        })),
        arb_checks: { calendar: 'pass', butterfly: 'pass', notes: 'static-arbitrage checks re-run each snapshot' },
      });
    case 'iv_term_structure':
      return envelopeWithSpot(symbol, {
        points: expiries.slice(0, 12).map((e) => ({ dte: e.dte, expiry: e.token, atm_iv: ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`) })),
        front_iv: ivAt(symbol, 0, 1, `${symbol}|atm|1`), term_slope_30_7: r1(rand() * 6 - 1),
      });
    case 'iv_skew':
      return envelopeWithSpot(symbol, {
        expiries: expiries.slice(0, 10).map((e) => {
          const c25 = ivAt(symbol, 0.12, e.dte, `${symbol}|c25|${e.token}`);
          const p25 = ivAt(symbol, -0.12, e.dte, `${symbol}|p25|${e.token}`);
          const c10 = ivAt(symbol, 0.2, e.dte, `${symbol}|c10|${e.token}`);
          const p10 = ivAt(symbol, -0.2, e.dte, `${symbol}|p10|${e.token}`);
          return { expiry: e.token, dte: e.dte, atm_iv: ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`), rr_25d: r1(c25 - p25), rr_10d: r1(c10 - p10), bf_25d: r1((c25 + p25) / 2 - ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`)), put_25d_iv: p25, call_25d_iv: c25 };
        }),
      });
    case 'iv_curves':
      return envelopeWithSpot(symbol, {
        expiries: expiries.slice(0, 8).map((e) => {
          const sm = strikesAround(spot, symbol, 15, 12);
          return { expiry: e.token, dte: e.dte, smile: sm.map((k) => ({ strike: k, moneyness_pct: r1((k / spot - 1) * 100), iv_call: ivAt(symbol, Math.max(0, k / spot - 1), e.dte, `${symbol}|${k}|c`), iv_put: ivAt(symbol, Math.min(0, k / spot - 1), e.dte, `${symbol}|${k}|p`) })) };
        }),
      });
    case 'iv_smile': {
      const e = pickExpiry(symbol, p.expiry ?? 'next', expiries);
      const sm = strikesAround(spot, symbol, 19, 14);
      return envelopeWithSpot(symbol, {
        expiry: e.token, dte: e.dte,
        points: sm.map((k) => ({ strike: k, log_moneyness: r2(Math.log(k / spot)), iv: ivAt(symbol, k / spot - 1, e.dte, `${symbol}|${k}|${e.token}`) })),
        atm: ivAt(symbol, 0, e.dte, `${symbol}|atm|${e.token}`),
        rr_25d: r1(-4 + rand() * 3), bf_25d: r1(0.5 + rand()), arb_checks: { butterfly: 'pass', vertical: 'pass' },
      });
    }
    case 'iv_ivrv': {
      const days = clamp(Number(p.days ?? 90), 14, 365);
      const ivw = walk(days, base, 0.06, `${seed}|iv`);
      return envelopeWithSpot(symbol, {
        points: ivw.map((v, i) => {
          const date = isoDate(new Date(Date.now() - (days - 1 - i) * 86400_000));
          const rv = clamp(v * (0.82 + rand() * 0.3), 5, 300);
          return { date, implied: r1(v), realized: r1(rv), spread: r1(v - rv) };
        }),
        current: { implied: r1(ivw[ivw.length - 1]), realized: r1(ivw[ivw.length - 1] * 0.87), spread: r1(ivw[ivw.length - 1] * 0.13) },
      });
    }
    case 'iv_vrp': {
      const days = clamp(Number(p.days ?? 90), 14, 365);
      const w = walk(days, 5, 0.8, `${seed}|vrp`);
      return envelopeWithSpot(symbol, {
        points: w.map((v, i) => ({ date: isoDate(new Date(Date.now() - (days - 1 - i) * 86400_000)), vrp: r1(v) })),
        mean: r1(w.reduce((s, v) => s + v, 0) / w.length),
        percentile: r0(rand() * 100), current: r1(w[w.length - 1]),
      });
    }
    case 'options_expected_move': {
      const e = pickExpiry(symbol, p.expiry ?? 'next', expiries);
      const atm = ivAt(symbol, 0, 1, `${symbol}|atm`);
      const s1 = (atm / 100) * spot;
      return envelopeWithSpot(symbol, {
        horizon: '1d', expiry: e.token, dte: e.dte, atm_iv: atm,
        one_sigma: { low: r0(spot - s1), high: r0(spot + s1), pct: r1((s1 / spot) * 100) },
        two_sigma: { low: r0(spot - 2 * s1), high: r0(spot + 2 * s1), pct: r1((2 * s1 / spot) * 100) },
        straddle_price: r0(s1 * 0.8), as_of: iso(new Date()),
      });
    }
    case 'options_range': {
      const mk = (h: number, mult: number) => {
        const s = ((base / 100) / Math.sqrt(365 / (h / 24))) * spot * mult;
        return { low: r0(spot - s), high: r0(spot + s), pct: r1((s / spot) * 100) };
      };
      return envelopeWithSpot(symbol, {
        track_record_days: 180, calibration: 'realized-move rescaling',
        horizons: [
          { horizon: '1h', band_68: mk(1, 0.72), band_90: mk(1, 1.18), hit_rate_68: r1(66 + rand() * 5), hit_rate_90: r1(89 + rand() * 4) },
          { horizon: '4h', band_68: mk(4, 0.74), band_90: mk(4, 1.16), hit_rate_68: r1(65 + rand() * 6), hit_rate_90: r1(88 + rand() * 5) },
          { horizon: '24h', band_68: mk(24, 0.78), band_90: mk(24, 1.12), hit_rate_68: r1(64 + rand() * 7), hit_rate_90: r1(87 + rand() * 6) },
        ],
      });
    }

    // ── probability ────────────────────────────────────────────────────────
    case 'probability_density': {
      const e = pickExpiry(symbol, p.expiry ?? 'next', expiries);
      const sm = strikesAround(spot, symbol, 25, 14);
      const raw = sm.map((k) => Math.exp(-(((k / spot - 1) / (base / 100 * Math.sqrt(Math.max(1, e.dte) / 365))) ** 2) / 2) * (0.9 + rand() * 0.2));
      const sum = raw.reduce((s, v) => s + v, 0);
      const pdf = raw.map((v) => r2((v / sum) * 100));
      let cum = 0;
      const cdf = pdf.map((v) => r1((cum += v)));
      const meanIdx = pdf.indexOf(Math.max(...pdf));
      return envelopeWithSpot(symbol, {
        expiry: e.token, dte: e.dte, strikes: sm, pdf, cdf,
        mean: sm[Math.floor(sm.length / 2)], mode: sm[meanIdx],
        stddev: r0(spot * (base / 100) * Math.sqrt(Math.max(1, e.dte) / 365)),
        confidence_band: { p68: [sm[8], sm[16]], p90: [sm[5], sm[19]] },
        prob_above_spot: r1(100 - cdf[Math.floor(sm.length / 2)]), prob_below_spot: r1(cdf[Math.floor(sm.length / 2)]),
      });
    }
    case 'probability_surface': {
      const rows = strikesAround(spot, symbol, 17, 14);
      const cols = expiries.slice(0, 6);
      const raw = rows.map((k) => cols.map((e) => Math.exp(-(((k / spot - 1) / (base / 100 * Math.sqrt(Math.max(1, e.dte) / 365))) ** 2) / 2)));
      const norm = raw.map((row) => {
        const s = row.reduce((a, b) => a + b, 0) || 1;
        return row.map((v) => r2((v / s) * 100));
      });
      return envelopeWithSpot(symbol, { strikes: rows, expiries: cols.map((e) => e.token), pdf_matrix: norm, unit: '% risk-neutral density per (strike, expiry)' });
    }

    // ── greeks ─────────────────────────────────────────────────────────────
    case 'greeks_profile': {
      const greek = String(p.greek ?? 'gamma');
      const unit = greek === 'gamma' ? '$ / 1% spot' : greek === 'vega' ? '$ / vol pt' : greek === 'vanna' ? '$ / (vol pt × 1%)' : greek === 'charm' ? '$ / day' : 'contracts';
      const mult = greek === 'gamma' ? 1 : greek === 'vega' ? 0.19 : greek === 'vanna' ? 0.06 : greek === 'charm' ? 0.04 : 0.5;
      return envelopeWithSpot(symbol, {
        greek, unit, positioning: p.positioning ?? 'flow',
        strikes, net: gex.net.map((v) => r0(v * mult)), call: gex.call.map((v) => r0(v * mult)), put: gex.put.map((v) => r0(v * mult)),
        total_oi: oi.call.map((c, i) => c + oi.put[i]),
      });
    }
    case 'greeks_surface': {
      const greek = String(p.greek ?? 'charm');
      const rows = strikesAround(spot, symbol, 17, 12);
      const times = Array.from({ length: 18 }, (_, i) => iso(new Date(Date.now() - (17 - i) * 1800_000)));
      const matrix = rows.map(() => times.map(() => r0((rand() - 0.5) * 1.4e6 * scale)));
      return envelopeWithSpot(symbol, { greek, strikes: rows, times, matrix, unit: greek === 'charm' ? '$ / day' : '$ / vol pt', max_abs: r0(Math.max(...matrix.flat().map(Math.abs))) });
    }
    case 'greeks_3d_surface': {
      const greek = String(p.greek ?? 'gamma');
      const rows = strikesAround(spot, symbol, 19, 12);
      const cols = expiries.slice(0, 7);
      const matrix = rows.map((k, ri) => cols.map((e) => r0(gex.net[Math.min(strikes.length - 1, Math.round((ri / rows.length) * strikes.length))] / Math.sqrt(Math.max(1, e.dte || 0.5)) * (0.5 + rand() * 0.8))));
      return envelopeWithSpot(symbol, { greek, strikes: rows, expiries: cols.map((e) => e.token), dte: cols.map((e) => e.dte), matrix, unit: 'sum(greek × OI)', max_abs: r0(Math.max(...matrix.flat().map(Math.abs))) });
    }
    case 'greeks_trace':
    case 'greeks_trace_summary': {
      const greek = String(p.greek ?? 'gamma');
      const e = pickExpiry(symbol, p.expiry ?? 'next', expiries);
      const priceSteps = clamp(Number(p.price_steps ?? 25), 7, 61);
      const timeSteps = clamp(Number(p.time_steps ?? 12), 4, 24);
      const horizon = clamp(Number(p.horizon_hours ?? 48), 4, 240);
      const rangePct = clamp(Number(p.price_range_pct ?? 10), 2, 30);
      const prices = Array.from({ length: priceSteps }, (_, i) => r0(spot * (1 - rangePct / 100 + (i / (priceSteps - 1)) * (2 * rangePct) / 100)));
      const times = Array.from({ length: timeSteps }, (_, i) => ({
        ts: iso(new Date(Date.now() + (i * horizon) / timeSteps * 3600_000)),
        hours_in: r1((i * horizon) / timeSteps), hours_to_expiry: r1(Math.max(0, e.dte * 24 - (i * horizon) / timeSteps)),
      }));
      const matrix = prices.map((k) => times.map((t) => r0((rand() - 0.45) * 3.6e6 * scale / Math.max(0.5, t.hours_to_expiry / 24 + 0.4))));
      if (endpoint.id === 'greeks_trace') {
        return envelopeWithSpot(symbol, { greek, expiry: e.token, dte: e.dte, horizon_hours: horizon, price_range_pct: rangePct, prices, times, matrix, unit: greek === 'gamma' ? '$ / 1% spot' : greek === 'charm' ? '$ / day' : '$ / (vol pt × 1%)' });
      }
      const mid = Math.floor(priceSteps / 2);
      return envelopeWithSpot(symbol, {
        greek, expiry: e.token, dte: e.dte,
        pin_zones: [{ low: prices[mid - 2], high: prices[mid + 2], strength: 'primary' }, { low: prices[mid - 5], high: prices[mid - 4], strength: 'secondary' }],
        accel_pockets: [{ price: prices[mid + 4], hours: r1(horizon / 2), note: 'gamma accelerates as expiry approaches' }],
        lean: rand() < 0.5 ? 'dealers short gamma below spot — rallies dampened above the flip' : 'dealers long gamma above spot — dips absorbed near support',
        headline: `${symbol} ${greek} TRACE (${e.token}): flip near ${r0(prices[mid])}, pin risk concentrates ${prices[mid - 2]}–${prices[mid + 2]}`,
      });
    }

    // ── OI & flow ──────────────────────────────────────────────────────────
    case 'oi_by_expiry':
      return envelopeWithSpot(symbol, {
        expiries: expiries.map((e) => {
          const w = 1 / Math.sqrt(Math.max(1, e.dte || 0.5));
          return { expiry: e.token, dte: e.dte, type: e.type, call_oi: r0(oi.call.reduce((s, v) => s + v, 0) * w * 0.16 * (0.5 + rand() * 0.9)), put_oi: r0(oi.put.reduce((s, v) => s + v, 0) * w * 0.16 * (0.5 + rand() * 0.9)) };
        }).map((r) => ({ ...r, total_oi: r0(r.call_oi + r.put_oi), notional_oi_usd: r0((r.call_oi + r.put_oi) * spot * 0.5) })),
      });
    case 'oi_history': {
      const limit = clamp(Number(p.limit ?? 200), 10, 1000);
      const w = walk(limit, 42e3 * scale, 0.05, seed);
      return envelopeWithSpot(symbol, { points: w.map((v, i) => ({ ts: iso(new Date(Date.now() - (limit - 1 - i) * 3600_000)), total_oi: r0(v), call_oi: r0(v * 0.56), put_oi: r0(v * 0.44) })) });
    }
    case 'options_pcr': {
      const days = clamp(Number(p.days ?? 30), 5, 180);
      return envelopeWithSpot(symbol, {
        total: { oi_pcr: r2(0.72 + rand() * 0.4), volume_pcr: r2(0.8 + rand() * 0.4) },
        by_expiry: expiries.slice(0, 10).map((e) => ({ expiry: e.token, dte: e.dte, pcr: r2(0.6 + rand() * 0.8) })),
        daily: Array.from({ length: days }, (_, i) => ({ date: isoDate(new Date(Date.now() - (days - 1 - i) * 86400_000)), pcr: r2(0.65 + rand() * 0.7) })),
      });
    }
    case 'options_premium_tide': {
      const pts = seriesPoints(24, 60, seed);
      let cum = 0;
      return envelopeWithSpot(symbol, {
        horizon: p.horizon ?? '1d',
        call_premium_usd: r0(48e6 * scale * (0.6 + rand() * 0.8)), put_premium_usd: r0(39e6 * scale * (0.6 + rand() * 0.8)),
        net_premium_usd: r0(9e6 * scale * (rand() * 1.4 - 0.4)), tilt: r2(rand() * 0.4 - 0.1),
        points: pts.map((t) => { const v = (rand() - 0.47) * 2.5e6 * scale; cum += v; return { ts: iso(new Date(t)), net_premium: r0(v), cumulative: r0(cum) }; }),
      });
    }
    case 'futures_term_structure':
      return envelopeWithSpot(symbol, {
        maturities: [28, 60, 91, 182, 273, 365].map((d) => ({ maturity: isoDate(new Date(Date.now() + d * 86400_000)), dte: d, price: r2(spot * (1 + 0.0002 * d * (0.5 + rand()))), basis_annualized_pct: r1(rand() * 14 - 2) })),
        perp_basis_bps: r0(rand() * 24 - 8), curve_shape: rand() < 0.7 ? 'contango' : 'backwardation',
      });

    // ── liquidations ───────────────────────────────────────────────────────
    case 'liquidation_heatmap': {
      const rows = strikesAround(spot, symbol, 21, 12);
      const times = Array.from({ length: 16 }, (_, i) => iso(new Date(Date.now() + i * 3600_000)));
      const matrix = rows.map(() => times.map(() => r0(rand() * 100)));
      const clusters = matrix.map((row, i) => ({ price: rows[i], intensity: r0(Math.max(...row)) })).sort((a, b) => b.intensity - a.intensity).slice(0, 5);
      return envelopeWithSpot(symbol, { price_levels: rows, time_buckets: times, intensity_matrix: matrix, scale: '0–100 liquidation intensity', clusters, horizon_hours: 16 });
    }
    case 'liquidation_distribution': {
      const rows = strikesAround(spot, symbol, 21, 12);
      return envelopeWithSpot(symbol, {
        levels: rows.map((k) => ({ price: k, distance_pct: r1((k / spot - 1) * 100), long_usd: r0(rand() ** 2 * 240e6 * scale), short_usd: r0(rand() ** 2 * 180e6 * scale), leverage_est: `${5 + Math.floor(rand() * 20)}x` })),
        nearest_magnet: { side: rand() < 0.5 ? 'long' : 'short', price: r0(spot * (1.02 + rand() * 0.03)) },
      });
    }

    // ── market data ────────────────────────────────────────────────────────
    case 'market_candles': {
      const hours = clamp(Number(p.hours ?? 72), 1, 720);
      const ivl = p.interval ?? '1h';
      const ivlMin = ivl === '1m' ? 1 : ivl === '5m' ? 5 : ivl === '15m' ? 15 : ivl === '1h' ? 60 : ivl === '4h' ? 240 : 1440;
      const closes = walk(clamp(Math.round((hours * 60) / ivlMin), 10, 500), spot, 0.012, seed);
      return envelopeWithSpot(symbol, {
        symbol, interval: ivl,
        candles: closes.map((c, i) => {
          const o = i === 0 ? c : closes[i - 1];
          const vol = r2(rand() * (spot * 0.004));
          return { ts: iso(new Date(Date.now() - (closes.length - 1 - i) * ivlMin * 60_000)), open: r2(o), high: r2(Math.max(o, c) + vol), low: r2(Math.min(o, c) - vol), close: r2(c), volume: r0(rand() * 800 * scale * 10), buy_volume: r0(rand() * 420 * scale * 10), sell_volume: r0(rand() * 380 * scale * 10) };
        }),
      });
    }
    case 'market_open_interest': {
      const hours = clamp(Number(p.hours ?? 72), 1, 720);
      const w = walk(120, 18e9 * scale, 0.02, seed);
      return envelopeWithSpot(symbol, { points: w.map((v, i) => ({ ts: iso(new Date(Date.now() - (119 - i) * (hours * 3600_000) / 120)), open_interest_usd: r0(v), open_interest_contracts: r0(v / spot) })) });
    }
    case 'market_funding': {
      const hours = clamp(Number(p.hours ?? 72), 1, 720);
      return envelopeWithSpot(symbol, {
        current: { funding_rate: r4(rand() * 0.0003 - 0.00005), funding_annualized_pct: r1(rand() * 14 - 3) },
        points: Array.from({ length: 120 }, (_, i) => { const fr = rand() * 0.0003 - 0.00005; return { ts: iso(new Date(Date.now() - (119 - i) * (hours * 3600_000) / 120)), funding_rate: r4(fr), funding_annualized_pct: r1(fr * 365 * 100) }; }),
      });
    }
    case 'market_cvd': {
      const hours = clamp(Number(p.hours ?? 72), 1, 720);
      let cum = 0;
      return envelopeWithSpot(symbol, {
        market: p.market ?? 'perp', spot: r2(spot),
        points: Array.from({ length: 120 }, (_, i) => { const b = rand() * 4e5 * scale; const s = rand() * 4e5 * scale; const d = b - s; cum += d; return { ts: iso(new Date(Date.now() - (119 - i) * (hours * 3600_000) / 120)), buy_volume: r0(b), sell_volume: r0(s), delta: r0(d), cumulative: r0(cum) }; }),
      });
    }
    case 'market_bundle': {
      const hours = clamp(Number(p.hours ?? 72), 1, 720);
      const closes = walk(120, spot, 0.01, seed);
      const oi = walk(120, 18e9 * scale, 0.02, `${seed}|oi`);
      return envelopeWithSpot(symbol, {
        symbol, interval: p.interval ?? '1h', spot: r2(spot),
        points: closes.map((c, i) => ({ ts: iso(new Date(Date.now() - (119 - i) * (hours * 3600_000) / 120)), price: r2(c), open_interest: r0(oi[i]), funding_rate: r4(rand() * 0.0003 - 0.00005) })),
      });
    }
    case 'market_liquidations': {
      const hours = clamp(Number(p.hours ?? 72), 1, 720);
      return envelopeWithSpot(symbol, { points: Array.from({ length: 120 }, (_, i) => ({ ts: iso(new Date(Date.now() - (119 - i) * (hours * 3600_000) / 120)), long_usd: r0(rand() ** 2 * 30e6 * scale), short_usd: r0(rand() ** 2 * 22e6 * scale) })) });
    }

    // ── ETF / COT / filings ────────────────────────────────────────────────
    case 'etf_flows': {
      const btcFunds = [
        { ticker: 'IBIT', name: 'iShares Bitcoin Trust', aum: 62e9 }, { ticker: 'FBTC', name: 'Fidelity Wise Origin Bitcoin', aum: 14e9 },
        { ticker: 'GBTC', name: 'Grayscale Bitcoin Trust', aum: 21e9 }, { ticker: 'ARKB', name: 'ARK 21Shares Bitcoin', aum: 3.4e9 },
        { ticker: 'BITB', name: 'Bitwise Bitcoin ETF', aum: 2.9e9 },
      ];
      const ethFunds = [
        { ticker: 'ETHA', name: 'iShares Ethereum Trust', aum: 9.2e9 }, { ticker: 'ETHE', name: 'Grayscale Ethereum Trust', aum: 5.6e9 },
        { ticker: 'CETH', name: 'Core Ethereum ETF', aum: 1.1e9 },
      ];
      const isEth = symbol.startsWith('ETH');
      const funds = (isEth ? ethFunds : btcFunds).map((f) => ({ ...f, daily_net_flow_usd: r0((rand() - 0.42) * (f.aum * 0.012)), cumulative_net_flow_usd: r0(f.aum * (0.3 + rand() * 0.5)) }));
      return envelope(null, {
        symbol: isEth ? 'ETH' : 'BTC', region: p.region ?? 'us',
        funds, total: { daily_net_flow_usd: r0(funds.reduce((s, f) => s + f.daily_net_flow_usd, 0)), cumulative_net_flow_usd: r0(funds.reduce((s, f) => s + f.cumulative_net_flow_usd, 0)) },
        as_of_settlement: isoDate(new Date(Date.now() - 86400_000)), note: 'flows settle daily — figures are a business day behind by design',
      }, 'Demo: daily creations/redemptions pattern after real spot-ETF flow reporting.');
    }
    case 'etf_premium': {
      const funds = symbol.startsWith('ETH') ? ['ETHA', 'ETHE', 'CETH'] : ['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB'];
      return envelope(null, { symbol: symbol.slice(0, 3), funds: funds.map((t) => ({ ticker: t, market_price: r2(spot * (0.998 + rand() * 0.004)), nav: r2(spot), premium_pct: r2((rand() - 0.5) * 0.6) })) });
    }
    case 'etf_aum': {
      const funds = symbol.startsWith('ETH')
        ? [{ ticker: 'ETHA', aum: 9.2e9 }, { ticker: 'ETHE', aum: 5.6e9 }, { ticker: 'CETH', aum: 1.1e9 }]
        : [{ ticker: 'IBIT', aum: 62e9 }, { ticker: 'FBTC', aum: 14e9 }, { ticker: 'GBTC', aum: 21e9 }, { ticker: 'ARKB', aum: 3.4e9 }, { ticker: 'BITB', aum: 2.9e9 }];
      return envelope(null, {
        symbol: symbol.slice(0, 3), total_aum_usd: r0(funds.reduce((s, f) => s + f.aum, 0)),
        funds: funds.map((f) => ({ ...f, change_1d_usd: r0((rand() - 0.45) * f.aum * 0.012) })),
      }, 'Demo AUM levels pattern the real US spot crypto ETF complex.');
    }
    case 'cot_summary': {
      const mk = (key: string, name: string, cls: string) => ({
        key, name, asset_class: cls, report: 'CFTC COT legacy futures-only',
        net_leveraged_funds: r0((rand() - 0.5) * 40e3), net_asset_managers: r0((rand() - 0.4) * 60e3), net_dealers: r0((rand() - 0.5) * 12e3),
        weekly_change: r0((rand() - 0.5) * 6e3), percentile_3y: r0(rand() * 100), extremeness: r1(rand() * 10),
      });
      return envelope(null, {
        window: p.window ?? '3y',
        markets: [mk('cme_btc', 'CME Bitcoin Futures', 'crypto'), mk('cme_eth', 'CME Ether Futures', 'crypto'), mk('cme_micro_btc', 'CME Micro Bitcoin', 'crypto'), mk('cme_sp500', 'S&P 500 Consolidated', 'financial'), mk('cme_nasdaq', 'Nasdaq 100 Consolidated', 'financial')],
      }, 'Demo: CFTC Commitments of Traders weekly positioning shapes.');
    }
    case 'cot_instrument': {
      const weeks = clamp(Number(p.weeks ?? 52), 8, 156);
      const key = String(p.key ?? 'cme_btc');
      const w = walk(weeks, 12e3, 0.25, `${seed}|cot`);
      return envelope(null, {
        key, name: key === 'cme_eth' ? 'CME Ether Futures' : key === 'cme_btc' ? 'CME Bitcoin Futures' : key,
        report: 'CFTC COT legacy futures-only',
        weeks: w.map((v, i) => ({ week: isoDate(new Date(Date.now() - (weeks - 1 - i) * 7 * 86400_000)), leveraged_funds: r0(v), asset_managers: r0(-v * 0.7), dealers: r0(v * 0.12), other_reportables: r0(v * 0.2), open_interest: r0(Math.abs(v) * 8) })),
      });
    }
    case 'cot_markets':
      return envelope(null, {
        markets: [
          { key: 'cme_btc', name: 'CME Bitcoin Futures', asset_class: 'crypto', report: 'legacy futures-only' },
          { key: 'cme_eth', name: 'CME Ether Futures', asset_class: 'crypto', report: 'legacy futures-only' },
          { key: 'cme_micro_btc', name: 'CME Micro Bitcoin', asset_class: 'crypto', report: 'legacy futures-only' },
          { key: 'cme_sp500', name: 'S&P 500 Consolidated', asset_class: 'financial', report: 'legacy futures-only' },
          { key: 'cme_nasdaq', name: 'Nasdaq 100 Consolidated', asset_class: 'financial', report: 'legacy futures-only' },
        ],
      });
    case 'filings_insider': {
      const ticker = String(p.ticker ?? 'COIN').toUpperCase() === 'HOOD' ? 'HOOD' : 'COIN';
      const people = ticker === 'COIN'
        ? [['Brian Armstrong', 'CEO'], ['Emilie Choi', 'President & COO'], ['Alesia Haas', 'CFO'], ['Paul Grewal', 'Chief Legal Officer'], ['Lawrence Alucca', 'Officer']]
        : [['Vlad Tenev', 'CEO'], ['Juan Zuniga', 'Officer'], ['Jason Warnick', 'CFO'], ['April Klein', 'Director']];
      const lb = String(p.lookback ?? '90d');
      return envelope(null, {
        ticker, lookback: lb,
        transactions: Array.from({ length: 18 }, () => {
          const [name, role] = people[Math.floor(rand() * people.length)];
          const shares = r0(rand() ** 2 * 40_000 + 100);
          const price = ticker === 'COIN' ? r2(180 + rand() * 140) : r2(28 + rand() * 34);
          return { filing_date: isoDate(new Date(Date.now() - rand() * 90 * 86400_000)), insider: name, role, action: rand() < 0.78 ? 'sell' : 'buy', shares, price_usd: price, value_usd: r0(shares * price), form: '4' };
        }).sort((a, b) => (a.filing_date < b.filing_date ? 1 : -1)),
      }, 'Demo: SEC Form 4 pattern at COIN / HOOD.');
    }
    case 'filings_holders': {
      const ticker = ['MSTR', 'COIN', 'HOOD', 'IBIT'].includes(String(p.ticker ?? '')) ? String(p.ticker) : 'MSTR';
      const holders = [
        ['BlackRock Inc.', 8.4e6], ['The Vanguard Group', 9.1e6], ['State Street Corp', 3.8e6], ['Fidelity (FMR)', 2.9e6],
        ['Citadel Advisors LLC', 1.9e6], ['Millennium Management', 1.6e6], ['Point72 Asset Management', 1.2e6], ['Geode Capital', 2.2e6],
      ];
      const price = ticker === 'MSTR' ? 320 : ticker === 'COIN' ? 240 : ticker === 'HOOD' ? 42 : 58;
      return envelope(null, {
        ticker, quarter: 'Q3 2026',
        holders: holders.slice(0, clamp(Number(p.limit ?? 8), 3, 15)).map(([name, sh]) => {
          const shares = r0((sh as number) * (0.8 + rand() * 0.5));
          return { holder: name, shares, value_usd: r0(shares * price), change_shares: r0((rand() - 0.45) * shares * 0.12), change_pct: r1((rand() - 0.45) * 12), quarter: '2026Q3' };
        }),
      }, 'Demo: SEC 13F institutional holder pattern.');
    }

    // ── tape ───────────────────────────────────────────────────────────────
    case 'tape': {
      const limit = clamp(Number(p.limit ?? 100), 5, 500);
      const trades = await demoTrades(symbol, limit, 168, 'tape');
      return envelopeWithSpot(symbol, { trades, total_in_window: r0(limit * (3 + rand() * 5)) });
    }
    case 'tape_recent': {
      const limit = clamp(Number(p.limit ?? 50), 5, 500);
      const trades = await demoTrades(symbol, limit, 6, 'recent');
      return envelopeWithSpot(symbol, { trades });
    }
    case 'tape_stats': {
      const hours = clamp(Number(p.hours ?? 24), 1, 168);
      const tradeCount = r0(hours * (140 + rand() * 260) * (symbol === 'BTCUSDT' ? 1 : 0.7));
      const buy = r0(tradeCount * (0.5 + rand() * 0.08));
      return envelopeWithSpot(symbol, {
        window_hours: hours, trade_count: tradeCount,
        total_premium_usd: r0(tradeCount * (9000 + rand() * 26000) * scale),
        buy_premium_usd: r0(buy * 13000 * scale), sell_premium_usd: r0((tradeCount - buy) * 13000 * scale),
        notional_volume_usd: r0(tradeCount * 21000 * scale),
        call_share_pct: r1(48 + rand() * 12), put_share_pct: r1(40 + rand() * 8),
        top_venue: 'deribit',
        venue_split: VENUE_WEIGHTS.map(([v, w]) => ({ venue: v, share_pct: r1(w * 100 * (0.8 + rand() * 0.4)), premium_usd: r0(tradeCount * 13000 * scale * w) })),
        block_count: r0(tradeCount * 0.05), whale_count: r0(6 + rand() * 28),
      });
    }
    case 'tape_imbalance': {
      const hours = clamp(Number(p.hours ?? 24), 1, 168);
      const bm = clamp(Number(p.bucket_minutes ?? 60), 5, 1440);
      const pts = seriesPoints(hours, bm, seed);
      let cum = 0;
      return envelopeWithSpot(symbol, {
        weight: p.weight ?? 'premium',
        buckets: pts.map((t) => { const b = (rand() - 0.47) * 1.6e6 * scale; cum += b; return { ts: iso(new Date(t)), buy_usd: r0(Math.abs(b) + rand() * 8e5 * scale), sell_usd: r0(Math.abs(b) + rand() * 8e5 * scale), imbalance: r0(b), cumulative: r0(cum) }; }),
      });
    }
    case 'tape_strike_heat': {
      const top = clamp(Number(p.top ?? 15), 5, 40);
      const rows = strikesAround(spot, symbol, 21, 12).slice(0, top);
      return envelopeWithSpot(symbol, {
        strikes: rows.map((k) => ({ strike: k, abs_premium_usd: r0(rand() ** 2 * 22e6 * scale), net_premium_usd: r0((rand() - 0.48) * 12e6 * scale), buy_usd: r0(rand() * 11e6 * scale), sell_usd: r0(rand() * 11e6 * scale), trades: r0(rand() * 320) })).sort((a, b) => b.abs_premium_usd - a.abs_premium_usd),
      });
    }
    case 'tape_flow_by_strike': {
      const rows = strikesAround(spot, symbol, 21, 12);
      return envelopeWithSpot(symbol, {
        strikes: rows.map((k) => ({ strike: k, expiry: expiries[1 + Math.floor(rand() * 5)].token, call_buy_usd: r0(rand() ** 2 * 14e6 * scale), call_sell_usd: r0(rand() ** 2 * 10e6 * scale), put_buy_usd: r0(rand() ** 2 * 9e6 * scale), put_sell_usd: r0(rand() ** 2 * 12e6 * scale) })).map((r) => ({ ...r, net_aggressor_usd: r0(r.call_buy_usd + r.put_buy_usd - r.call_sell_usd - r.put_sell_usd) })),
      });
    }
    case 'tape_whale': {
      const limit = clamp(Number(p.limit ?? 20), 5, 100);
      const hours = clamp(Number(p.hours ?? 24), 1, 168);
      const trades = await demoTrades(symbol, limit * 6, hours, 'whale');
      const whales = trades.filter((t) => t.premium_usd > 250_000).slice(0, limit);
      return envelopeWithSpot(symbol, { window_hours: hours, whales: whales.length ? whales : trades.slice(0, limit).map((t) => ({ ...t, premium_usd: r0(250_000 + rand() * 2.4e6) })) });
    }

    default:
      return envelope(symbol, { note: `demo generator not implemented for ${endpoint.id} — endpoint is still proxied live when BACKQUANT_API_KEY is set` }, 'Unimplemented demo surface.');
  }
}
