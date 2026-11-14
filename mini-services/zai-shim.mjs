#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// zai-shim — a tiny local OpenAI-compatible front for the in-sandbox GLM
// endpoint (https://internal-api.z.ai/v1).
//
// WHY: the upstream requires session headers (X-Z-AI-From: Z, X-Chat-Id,
// X-User-Id, X-Token) that live in /etc/.z-ai-config and can rotate between
// sandbox sessions. Gateways (OmniRoute / Respan) can't inject dynamic
// per-request headers, so this shim presents a plain OpenAI-compatible
// endpoint on :20130 and re-reads /etc/.z-ai-config on EVERY request, always
// attaching the live headers. Result: the gateways see a keyless standard
// OpenAI API that keeps working across session rotations.
//
// Endpoints:
//   GET  /healthz               → liveness
//   GET  /v1/models             → upstream /models (static fallback list)
//   POST /v1/chat/completions   → proxied verbatim (SSE passthrough)
//
// Usage:  node mini-services/zai-shim.mjs   (PORT=20130 default)
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.ZAI_SHIM_PORT || 20130);
const CONFIG_PATH = process.env.ZAI_CONFIG_PATH || '/etc/.z-ai-config';
const STATIC_MODELS = ['glm-4-plus', 'glm-4-flash'];

function readLiveConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (cfg && cfg.baseUrl && cfg.apiKey) return cfg;
  } catch { /* re-read next request */ }
  return null;
}

function buildHeaders(cfg) {
  const h = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  };
  if (cfg.chatId) h['X-Chat-Id'] = cfg.chatId;
  if (cfg.userId) h['X-User-Id'] = cfg.userId;
  if (cfg.token) h['X-Token'] = cfg.token;
  return h;
}

async function proxy(req, res, pathOverride) {
  const cfg = readLiveConfig();
  if (!cfg) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'zai-shim: /etc/.z-ai-config unavailable' } }));
    return;
  }
  const target = `${cfg.baseUrl}${pathOverride ?? req.url}`;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { ...buildHeaders(cfg), ...(body ? { 'Content-Length': String(body.length) } : {}) },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      duplex: 'half',
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `zai-shim: upstream unreachable (${err.message || err})` } }));
    return;
  }
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'content-encoding' && k.toLowerCase() !== 'transfer-encoding') headers[k] = v;
  });
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'internal-api.z.ai' }));
    return;
  }
  if (url === '/v1/models' && req.method === 'GET') {
    // Try the upstream first; fall back to a static list so gateways can
    // always discover at least the models the desk uses.
    const cfg = readLiveConfig();
    if (cfg) {
      try {
        const r = await fetch(`${cfg.baseUrl}/models`, { headers: buildHeaders(cfg) });
        if (r.ok) {
          const txt = await r.text();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(txt);
          return;
        }
      } catch { /* fall through */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: STATIC_MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }
  if (url === '/v1/chat/completions' || url === '/chat/completions') {
    await proxy(req, res, '/chat/completions');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `zai-shim: no route for ${req.method} ${url}` } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[zai-shim] listening on http://127.0.0.1:${PORT} → https://internal-api.z.ai/v1 (live headers per request)`);
});
