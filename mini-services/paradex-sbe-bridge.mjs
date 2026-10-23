#!/usr/bin/env node
// ---------------------------------------------------------------------------
// paradex-sbe-bridge — standalone market-data bridge for Paradex (SBE WS).
//
// Paradex's public REST market data needs JWT auth, and since 2026-09-21 its
// public WebSocket channels require Simple Binary Encoding (SBE) frames.
// This little service:
//   1. opens ONE SBE WebSocket to wss://ws.api.prod.paradex.trade/v1
//   2. manages refcounted/lease-based per-market `markets_summary.{market}`
//      subscriptions (each market pushes 1 frame/second — real bid/ask, IV,
//      greeks, OI, index, volume)
//   3. decodes the binary SBE frames (schema 1:2, little-endian)
//   4. serves the latest snapshot over localhost HTTP
//
// Endpoints (port 3100, or $PARADEX_BRIDGE_PORT):
//   GET  /health                     → { ok, connected, markets, uptimeS, lastMsgAgeMs }
//   GET  /snapshot?markets=A,B,C     → { quotes: { [market]: summary } }
//   GET  /snapshot?prefix=BTC-USD-24OCT26 → same, filtered by prefix
//   POST /ensure   { markets: [...] }→ (re)subscribe + extend 10-min leases
//
// Run:  node mini-services/paradex-sbe-bridge.mjs   (requires 'ws' in ../node_modules)
// ---------------------------------------------------------------------------

import http from 'node:http';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PARADEX_BRIDGE_PORT || 3100);
const WS_URL = 'wss://ws.api.prod.paradex.trade/v1?sbeSchemaId=1&sbeSchemaVersion=2';
const LEASE_MS = 10 * 60 * 1000; // markets unwatched for 10 min get unsubscribed
const BOOT_MARKETS = ['BTC-USD-PERP', 'ETH-USD-PERP']; // always-on spot marks

// ---- SBE decoding (schema 1:2 — paradex_1_0.xml) --------------------------
const NULL64 = -9223372036854775808n;
const i64 = (b, o) => b.readBigInt64LE(o);
const fx = (v, exp) => (v === NULL64 ? null : Number(v) * Math.pow(10, exp));
const P8 = (b, o) => fx(i64(b, o), -8); // Price8 / Qty8 / Value8 / Rate8
const R12 = (b, o) => fx(i64(b, o), -12); // Rate12
const TS = (b, o) => Number(i64(b, o) / 1000n); // µs → ms

function decodeMarketSummary(b) {
  let o = 8; // skip messageHeader (blockLength/templateId/schemaId/version)
  const g = () => { const v = P8(b, o); o += 8; return v; };
  const F = {};
  F.ts = TS(b, o); o += 8;
  F.seq = Number(i64(b, o)); o += 8;
  F.markPrice = g(); F.indexPrice = g(); F.lastPrice = g();
  F.volumeUsd24h = g(); F.openInterest = g(); F.fundingRate = g();
  F.bid = g(); F.ask = g();
  F.totalVolume = g(); F.priceChangeRate24h = g();
  F.markIv = g(); F.bidIv = g(); F.askIv = g(); F.lastIv = g();
  F.delta = g(); F.gamma = g(); F.vega = g(); F.theta = g(); F.rho = g();
  F.volga = g(); F.vanna = g();
  F.futureFundingRate = g(); F.externalFairPrice = g();
  F.bidSize = g(); F.askSize = g();
  F.forwardRate = g(); F.riskFreeRate = g();
  F.fundingRatePrecise = R12(b, o); o += 8;
  const n = b.readUInt8(o); o += 1;
  F.market = b.subarray(o, o + n).toString('utf8');
  return F;
}

// ---- state ----------------------------------------------------------------
/** market → { summary, leaseUntil, subscribed } */
const watched = new Map();
let ws = null;
let connected = false;
let reqId = 1;
let lastMsgAt = 0;
let frames = 0;
const startedAt = Date.now();
let backoff = 1000;

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function subscribe(market) {
  const w = watched.get(market);
  if (!w || w.subscribed) return;
  w.subscribed = true;
  send({ jsonrpc: '2.0', method: 'subscribe', params: { channel: `markets_summary.${market}` }, id: reqId++ });
  log('subscribe', market);
}

function unsubscribe(market) {
  const w = watched.get(market);
  if (!w || !w.subscribed) return;
  w.subscribed = false;
  send({ jsonrpc: '2.0', method: 'unsubscribe', params: { channel: `markets_summary.${market}` }, id: reqId++ });
  log('unsubscribe', market);
}

function connect() {
  log('connecting', WS_URL);
  ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });

  ws.on('open', () => {
    connected = true;
    backoff = 1000;
    log('connected — resubscribing', watched.size, 'markets');
    for (const [m, w] of watched) {
      w.subscribed = false;
      if (w.leaseUntil > Date.now()) subscribe(m);
    }
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // JSON acks/errors ignored (control plane)
    const b = Buffer.from(data);
    if (b.length < 10) return;
    const templateId = b.readUInt16LE(2);
    if (templateId !== 4) return; // only MarketSummaryEvent
    frames++;
    lastMsgAt = Date.now();
    try {
      const F = decodeMarketSummary(b);
      const w = watched.get(F.market);
      if (w) w.summary = F;
    } catch {
      /* malformed frame — ignore */
    }
  });

  ws.on('error', (e) => log('ws error:', e.message));
  ws.on('close', () => {
    connected = false;
    log('closed — reconnect in', backoff, 'ms');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
}

// lease sweep: drop markets nobody asked about for LEASE_MS
setInterval(() => {
  const now = Date.now();
  for (const [m, w] of watched) {
    if (BOOT_MARKETS.includes(m)) continue;
    if (w.leaseUntil < now && w.subscribed) {
      unsubscribe(m);
      watched.delete(m);
    }
  }
}, 60_000).unref();

// stats heartbeat
setInterval(() => {
  const fresh = [...watched.values()].filter((w) => w.summary && Date.now() - w.summary.ts < 30_000).length;
  log(`status: connected=${connected} watched=${watched.size} fresh=${fresh} frames=${frames}`);
}, 300_000).unref();

// ---- HTTP -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(200, {
      ok: true,
      connected,
      markets: watched.size,
      freshMarkets: [...watched.values()].filter((w) => w.summary && Date.now() - w.summary.ts < 30_000).length,
      frames,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null,
    });
  }

  if (req.method === 'GET' && url.pathname === '/snapshot') {
    const markets = (url.searchParams.get('markets') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const prefix = url.searchParams.get('prefix');
    const out = {};
    for (const [m, w] of watched) {
      if (!w.summary) continue;
      if ((markets.length && !markets.includes(m)) || (prefix && !m.startsWith(prefix))) continue;
      out[m] = w.summary;
    }
    return json(200, { ok: true, connected, count: Object.keys(out).length, quotes: out });
  }

  if (req.method === 'POST' && url.pathname === '/ensure') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { markets } = JSON.parse(body || '{}');
        if (!Array.isArray(markets) || markets.length === 0) return json(400, { ok: false, error: 'markets[] required' });
        if (markets.length > 400) return json(400, { ok: false, error: 'max 400 markets per call' });
        const now = Date.now();
        let added = 0;
        for (const m of markets) {
          if (typeof m !== 'string' || m.length > 64) continue;
          const w = watched.get(m);
          if (w) {
            w.leaseUntil = now + LEASE_MS;
            if (!w.subscribed && connected) subscribe(m);
          } else {
            watched.set(m, { summary: null, leaseUntil: now + LEASE_MS, subscribed: false });
            if (connected) subscribe(m);
            added++;
          }
        }
        return json(200, { ok: true, added, watched: watched.size });
      } catch (e) {
        return json(400, { ok: false, error: String(e?.message ?? e) });
      }
    });
    return;
  }

  json(404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`paradex-sbe-bridge listening on 127.0.0.1:${PORT}`);
  for (const m of BOOT_MARKETS) watched.set(m, { summary: null, leaseUntil: Infinity, subscribed: false });
  connect();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
